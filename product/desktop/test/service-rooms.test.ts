// Every watched service's own rooms and group meetings (0.7.0, owner decision 2026-11-19 "Services, and more than one
// service"): before, only the first service's check was used for room bookings and group meetings, and each other
// service's part said they weren't checked. Now each service's part shows its own, from its own check, with the first
// service's wording, sources, check times, "Why I flagged this" and choices; the church's follow-ups stay with the first
// service; a church-local day's rooms are shown and counted once, with the first service watched on that day; every count
// adds each service's own once; Today, Thursday's brief and the spoken briefing say each at its service. With one service,
// nothing changes. Fixed fictional data only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { FICTIONAL_ROOM, withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { sundayOperations, type SundayOperations } from "../../../core/src/operations-capture.js";
import { buildSundayBrief, sundayShownCount, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { applyDecisions } from "../../../core/src/sunday-decisions.js";
import type { SundayCapture, SundayRead, SundayRules } from "../../../core/src/sunday-capture.js";
import { correctionEntry, groupTarget, roomTarget } from "../../../core/src/finding-feedback.js";
import type { RoomFinding } from "../../../core/src/operations-findings/index.js";
import { wednesdayCapture, wednesdayWithOperations, wednesdayWords } from "../../../core/test/fixtures/service-days/wednesday.js";
import { alsoOperations, askServices, firstRoomsWith, harnessOperations, mergedNames, mergeParts, otherOperations, partKey, roomsHolders, teamServices, withOthers } from "../src/services-merge.js";
import { findingsFor } from "../src/responsibility-runner.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { composeAnswer, decisionsLeftOut } from "../../../core/src/harness/compose.js";
import type { AgentStepRequest, ModelStep } from "../../../core/src/harness/contract.js";
import { Harness } from "../../../core/src/harness/index.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { HarnessTools, OVERVIEW_FOLLOW_UP, OVERVIEW_GROUP, OVERVIEW_ROOM, type HarnessData } from "../../../core/src/harness/tools.js";
import { TsLoop } from "../../../core/src/harness/ts-loop.js";
import { sharedEnvelopes } from "../../../core/mcp/snapshot.js";
import { pinnedRequestProblems } from "../../../core/test/harness/native-rules.js";
import { followUpsWithLine, opsWithLine, roomsWithLine, SundayPage } from "../src/sunday-page.js";
import { decisionLines } from "../src/today-groups.js";
import { SundayReadyBrief } from "../src/sunday-ready.js";
import { AlsoOperationsContext } from "../src/team-labels.js";
import { DayProvider } from "../src/day-words.js";
import { MANY_SERVICES } from "../src/services-merge.js";

const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 0 };
const notShared: SundayRules = { ...rules, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 30 }] };
const WEEKEND = "Weekend Service", YOUTH = "Ozzie Demo Youth Night (fictional)";
/** Another service type of the same church: teams of its own, its own plan. */
const own = (c: SundayCapture, plan: string, type: string): SundayCapture =>
  ({ ...JSON.parse(JSON.stringify(c).replace(/\b75933(5[024])\b/gu, "85933$1")) as SundayCapture, service_type_id: type, plan_id: plan });
const weekend = () => withFictionalOperations(nov22Capture());
/** Youth Night on Wednesday, November 25: the same room double-booked that evening (bookings of its own), and a group that meets while someone serves. */
const youth = () => own(JSON.parse(JSON.stringify(wednesdayWithOperations()).replace(/"4100000(\d)"/gu, '"4200000$1"')) as SundayCapture, "94000001", "1700");
/** A second service on Sunday, November 22 itself: the same day's rooms as the first service. */
const evening = () => own(weekend(), "94000002", "1701");
const edit = (c: SundayCapture, collection: string, change: (r: SundayRead) => void) => { c.reads.filter(r => r.collection === collection).forEach(change); return c; };
const kinds = (o: SundayOperations | null) => o?.result?.findings.map(f => f.kind) ?? [];
const brief = (c: SundayCapture) => buildSundayBrief(c, rules, c.completed_at);
/** The same check read at `iso` instead (every read time moved with it). */
const shifted = (c: SundayCapture, iso: string): SundayCapture => {
  const delta = Date.parse(iso) - Date.parse(c.completed_at), move = (t: string) => new Date(Date.parse(t) + delta).toISOString();
  return { ...c, started_at: move(c.started_at), completed_at: move(c.completed_at), reads: c.reads.map(r => ({ ...r, checked_at: move(r.checked_at) })) };
};
const text = (html: string) => html.replace(/<[^>]+>/gu, "").replace(/&#x27;/gu, "'").replace(/&quot;/gu, "\"").replace(/&amp;/gu, "&");

describe("each other service's own rooms and group meetings (services-merge.ts otherOperations)", () => {
  it("two services on different days: each its own room clash, never the church's follow-ups", () => {
    const [y] = otherOperations(weekend(), [youth()], notShared);
    expect(y!.roomsWith).toBeNull();
    expect(kinds(y!.operations)).toEqual(["room-overlap"]);
    const overlap = y!.operations!.result!.findings[0] as RoomFinding;
    // Wednesday's own bookings, on Wednesday's church-local day.
    expect(overlap.overlap.starts_at.slice(0, 10)).toBe("2026-11-25");
    expect(overlap.label).toBe("Room use needs review");
    expect(y!.operations!.group_meetings).toHaveLength(1);
    expect(JSON.stringify(y!.operations)).not.toMatch(/workflow|unowned/u);
    // The first service's own check is exactly what it always was, its follow-up included.
    expect(kinds(sundayOperations(weekend(), notShared))).toEqual(["unowned-overdue", "room-overlap"]);
  });

  it("two services on the same day: that day's rooms once, with the first; the later one keeps its own group meetings", () => {
    const [e] = otherOperations(weekend(), [evening()], notShared);
    expect(e!.roomsWith).toBe(0);
    expect(e!.operations).toMatchObject({ result: null, clear: [], not_checked: [] });
    expect(e!.operations!.group_meetings).toHaveLength(1);
    // Two others on one day that isn't the first's: the earlier watched holds it.
    const [a, b] = otherOperations(weekend(), [youth(), own(wednesdayWithOperations(), "94000003", "1702")], notShared);
    expect([a!.roomsWith, b!.roomsWith]).toEqual([null, 1]);
    expect(kinds(b!.operations)).toEqual([]);
    // A first check with no Calendar, People or Groups reads at all holds no day: the other service's rooms are its own.
    expect(otherOperations(nov22Capture(), [evening()], notShared)[0]!.roomsWith).toBeNull();
  });

  it("counts: each service's own rooms and group meetings once, a shared day's rooms once", () => {
    const main = weekend(), mainOps = sundayOperations(main, notShared);
    const count = (others: SundayCapture[]) => {
      const ops = otherOperations(main, others, notShared);
      const parts = others.map((c, i) => ({ plan_id: c.plan_id, brief: brief(c), decisions: [], operations: ops[i]!.operations }));
      const m = mergeParts({ brief: brief(main), decisions: [] }, parts);
      return withOthers(sundayShownCount(applyDecisions(m.brief, m.decisions), mainOps), parts);
    };
    const alone = sundayShownCount(applyDecisions(brief(main), []), mainOps);
    const pageOf = (c: SundayCapture, o: SundayOperations | null) => sundayShownCount(applyDecisions(brief(c), []), o);
    // Different days: the first's count, plus Youth Night's own page count, its room clash and group meeting included.
    const y = otherOperations(main, [youth()], notShared)[0]!.operations;
    expect(count([youth()])).toEqual({ ...alone, decisions: alone.decisions + pageOf(youth(), y).decisions, looks: alone.looks + pageOf(youth(), y).looks });
    expect(pageOf(youth(), y).decisions).toBe(pageOf(youth(), null).decisions + 1);
    // The same day: the evening service adds its Services findings and its group meeting, never the shared room clash again.
    const e = otherOperations(main, [evening()], notShared)[0]!.operations;
    expect(pageOf(evening(), e)).toEqual({ ...pageOf(evening(), null), looks: pageOf(evening(), null).looks + 1 });
    expect(count([evening()]).decisions).toBe(alone.decisions + pageOf(evening(), null).decisions);
  });

  it("a group meeting that clashes with one service only is that service's alone", () => {
    // Youth Night's group meets an hour after its people serve.
    const later = edit(youth(), "groups_group_events", r => {
      (r.body!.data as { attributes: Record<string, unknown> }[])[0]!.attributes = { starts_at: "2026-11-25T16:00:00Z", ends_at: "2026-11-25T17:00:00Z", canceled: false };
    });
    const [y] = otherOperations(weekend(), [later], notShared);
    expect(y!.operations!.group_meetings).toEqual([]);
    expect(sundayOperations(weekend(), notShared)!.group_meetings).toHaveLength(1);
  });

  it("rooms turned off or unreadable for one service: said honestly in that service's part only", () => {
    const refused = edit(youth(), "calendar_resource_bookings", r => { r.outcome = "denied"; delete r.body; });
    const [y] = otherOperations(weekend(), [refused], notShared);
    expect(y!.operations!.not_checked).toContain("Room bookings: Planning Center didn't allow it.");
    expect(y!.operations!.clear).toEqual([]);
    expect(sundayOperations(weekend(), notShared)!.not_checked).not.toContain("Room bookings: Planning Center didn't allow it.");
  });

  it("one service: nothing new anywhere", () => {
    const count = sundayShownCount(applyDecisions(brief(weekend()), []), sundayOperations(weekend(), rules));
    expect(otherOperations(weekend(), [], rules)).toEqual([]);
    expect(withOthers(count, [])).toBe(count);
    expect(alsoOperations({ brief: brief(weekend()), name: WEEKEND }, [], [])).toBeUndefined();
  });
});

describe("another service's part of the Services page", () => {
  const part = (c: SundayCapture, operations: SundayOperations | null, roomsWith: string | null = null) => text(renderToStaticMarkup(React.createElement(DayProvider,
    { value: wednesdayWords() }, React.createElement(SundayPage, {
      brief: brief(c), names: c.names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true, canReword: false,
      decisions: [], onDecisions: () => undefined, operations, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
      feedback: { entries: [], onEntries: () => undefined }, part: { name: YOUTH, waiting: null, opsWith: WEEKEND, roomsWith },
    }))));

  it("shows its own Rooms and group-meeting cards in the first service's words, with sources, check time and choices", () => {
    const y = otherOperations(weekend(), [youth()], notShared)[0]!.operations;
    const t = part(youth(), y);
    expect(t).toContain("Rooms");
    expect(t).not.toContain("Rooms and follow-ups");
    // On the church's own clock, as the first service's card says it (Eastern: 9:00–11:00 and 10:45–11:15, with 30 minutes of setup).
    expect(t).toContain("Sanctuary (fictional) has overlapping bookings from 10:15 AM–11:00 AM.");
    expect(t).toContain("counting the 30 minutes of setup your Church rules set for this room.");
    expect(t).toContain("Review these room bookings in Planning Center Calendar.");
    expect(t).toContain("Why I flagged this");
    expect(t).toMatch(/CalendarChurch rulesChecked /u);
    expect(t).toContain("More choices");
    expect(t).toContain("has a group meeting at the same time.");
    expect(t).toMatch(/GroupsPlanning CenterChecked /u);
    // What I didn't check: the old sentence is gone; the church's follow-ups are said to be with the first service.
    expect(t).not.toContain("aren't checked for this service");
    expect(t).toContain(followUpsWithLine(WEEKEND));
    expect(t).not.toContain("follow-up has no owner");
  });

  it("the same day as the first service: says where that day's rooms are, and still shows its own group meetings", () => {
    const e = otherOperations(weekend(), [evening()], notShared)[0]!.operations;
    const t = part(evening(), e, WEEKEND);
    expect(t).toContain(roomsWithLine(WEEKEND));
    expect(t).toContain(followUpsWithLine(WEEKEND));
    expect(t).not.toContain("has overlapping bookings");
    expect(t).toContain("has a group meeting at the same time.");
  });

  it("an off or unreadable read is said as the first service says it; a check with no such reads keeps the old sentence", () => {
    const off = otherOperations(weekend(), [own({ ...wednesdayWithOperations(), reads: wednesdayWithOperations().reads.map(r =>
      r.collection.startsWith("calendar_") || r.collection.startsWith("groups_") || r.collection.startsWith("people_workflow") ? { ...r, outcome: "not-requested", body: undefined } as unknown as SundayRead : r) }, "94000001", "1700")], rules)[0]!.operations;
    const t = part(youth(), off);
    expect(t).toContain("Room bookings weren't checked. Turn this on in Settings.");
    expect(t).toContain("Group meetings weren't checked either.");
    expect(t).toContain(followUpsWithLine(WEEKEND));
    expect(part(youth(), null)).toContain(opsWithLine(WEEKEND));
  });

  it("a choice on its card is kept by its own plan, and only its own check's facts end it", () => {
    const y = otherOperations(weekend(), [youth()], notShared)[0]!.operations!;
    const room = y.result!.findings[0] as RoomFinding, meeting = y.group_meetings[0]!;
    const entries = [correctionEntry(roomTarget(room, "94000001", y.labels), "", "2026-11-20T16:00:00Z"), correctionEntry(groupTarget(meeting, "94000001"), "", "2026-11-20T16:00:00Z")];
    const kept = { ...notShared, feedback: entries };
    const set = otherOperations(weekend(), [youth()], kept)[0]!.operations!;
    expect(kinds(set)).toEqual([]);
    expect(set.group_meetings).toEqual([]);
    expect(set.hidden!.map(h => h.kind)).toEqual(["room-overlap", "group-meeting"]);
    // The first service's own room clash and group meeting (another plan) are untouched.
    const first = sundayOperations(weekend(), kept)!;
    expect(kinds(first)).toEqual(["unowned-overdue", "room-overlap"]);
    expect(first.group_meetings).toHaveLength(1);
    expect(first.hidden).toBeUndefined();
    // Youth Night's own facts changing (the second booking starting earlier) bring its room clash back.
    const moved = edit(youth(), "calendar_resource_bookings", r => {
      ((r.body!.data as { id: string; attributes: Record<string, unknown> }[]).find(b => b.id === "42000002")!).attributes.starts_at = "2026-11-25T15:30:00Z";
    });
    expect(kinds(otherOperations(weekend(), [moved], kept)[0]!.operations)).toEqual(["room-overlap"]);
  });
});

describe("Today and Thursday's brief say each service's rooms and group meetings at their service", () => {
  const youthOps = () => otherOperations(weekend(), [youth()], notShared)[0]!.operations;
  const also = () => ({ first: WEEKEND, also: [{ plan_id: "94000001", service: "Youth Night", operations: youthOps() }] });

  it("Today: a line per service's room clashes, opening that service's own part; follow-ups as before", () => {
    const lines = decisionLines([], { rooms: 1, followUps: 1 }, "America/New_York", MANY_SERVICES, undefined,
      [{ key: "rooms", service: WEEKEND, count: 1 }, { key: partKey("94000001", "rooms"), service: "Youth Night", count: 2 }]);
    expect(lines.named.map(l => [l.key, l.text])).toEqual([
      ["rooms", "At Weekend Service, a room has overlapping bookings to review."],
      [partKey("94000001", "rooms"), "At Youth Night, 2 room booking overlaps to review."],
      ["follow-ups", "A follow-up has no owner and is past due."],
    ]);
    // One service: exactly as before.
    expect(decisionLines([], { rooms: 1, followUps: 1 }, "America/New_York").named.map(l => l.text))
      .toEqual(["A room has overlapping bookings to review.", "A follow-up has no owner and is past due."]);
  });

  it("Thursday's brief: every service's rooms and group meetings at its service, in the one count", () => {
    const main = weekend(), ops = sundayOperations(main, notShared);
    const y = youth(), yb: SundayBrief = brief(y);
    const m = mergeParts({ brief: brief(main), decisions: [] }, [{ plan_id: y.plan_id, brief: yb, decisions: [] }]);
    const render = (value: ReturnType<typeof also> | undefined) => text(renderToStaticMarkup(React.createElement(AlsoOperationsContext.Provider, { value },
      React.createElement(DayProvider, { value: MANY_SERVICES }, React.createElement(SundayReadyBrief, { brief: m.brief, operations: ops, names: {}, onSunday: () => undefined })))));
    const t = render(also());
    expect(t).toContain("At Weekend Service, one room booking overlap to review.");
    expect(t).toContain("At Youth Night, one room booking overlap to review.");
    expect(t).toContain("At Youth Night, one person has a group meeting while they serve.");
    expect(t).toContain("One follow-up has no owner and is past due.");
    const counts = withOthers(sundayShownCount(applyDecisions(m.brief, []), ops), also().also);
    expect(t).toContain(`${counts.decisions} things need a decision, and ${counts.looks} are worth a look.`);
    // Without the other services' own (one service, or before 0.7.0): their lines aren't there.
    expect(render(undefined)).not.toContain("Youth Night");
  });
});

// Ask and the copies for other AI apps (0.7.0): a question naming a service reads that service's own rooms and group
// meetings, one naming none reads every service's once; rooms and people go as this session's labels, as the first
// service's do; nothing pinned changes (the request-hash pins in ask-service-labels, partial-words and other-service-look
// stay as recorded).
describe("Ask reads each service's own rooms and group meetings", () => {
  const signal = new AbortController().signal;
  const payload = (e: { payload: unknown }) => e.payload as Record<string, unknown>;
  const rows = (e: { payload: unknown }, list: string) => (payload(e)[list] ?? []) as Record<string, unknown>[];
  function asked(sameDay = false) {
    const main = weekend(), other = sameDay ? evening() : youth();
    const mainBrief = brief(main), otherBrief = brief(other);
    const [ops] = otherOperations(main, [other], notShared);
    const named = [{ plan_id: other.plan_id, brief: otherBrief, name: YOUTH }];
    const m = mergeParts({ brief: mainBrief, decisions: [] }, [{ plan_id: other.plan_id, brief: otherBrief, decisions: [] }]);
    const data: HarnessData = {
      capture: mergedNames(main, [other]), brief: m.brief, operations: sundayOperations(main, notShared), decisions: m.decisions, rules: notShared, attention: null,
      granted: ["services", "operations"], mode: "live", connected: true, serviceOfTeam: teamServices({ brief: mainBrief, name: WEEKEND }, named)!,
      ...askServices({ brief: mainBrief, name: WEEKEND }, named), alsoOperations: harnessOperations([{ name: YOUTH, operations: ops!.operations, roomsWith: ops!.roomsWith }])!,
    };
    const page = withOthers(sundayShownCount(applyDecisions(m.brief, []), data.operations), [{ operations: ops!.operations }]);
    return { data, now: main.completed_at, ops: ops!.operations!, page, tools: () => new HarnessTools(data, new HarnessSession(), { now: () => main.completed_at }) };
  }

  it("with no scope: every service's rooms and group meetings once, the church's follow-up once, and the page's own count", async () => {
    const a = asked(), tools = a.tools();
    const overview = await tools.run("sunday.overview", {}, signal, "t1");
    const kinds = rows(overview, "findings").map(r => r["kind"]);
    expect(kinds.filter(k => k === OVERVIEW_ROOM)).toHaveLength(2);
    expect(kinds.filter(k => k === OVERVIEW_GROUP)).toHaveLength(2);
    expect(kinds.filter(k => k === OVERVIEW_FOLLOW_UP)).toHaveLength(1);
    expect([payload(overview)["needs_a_decision"], payload(overview)["worth_a_look"]]).toEqual([a.page.decisions, a.page.looks]);
    const rooms = await tools.run("rooms.conflicts", {}, signal, "t1");
    expect(rows(rooms, "rooms").map(r => (r["overlap"] as { starts_at: string }).starts_at.slice(0, 10))).toEqual(["2026-11-22", "2026-11-25"]);
    // One room, one label, whichever service's day: its name stays on this Mac.
    expect(new Set(rows(rooms, "rooms").map(r => r["room"]))).toEqual(new Set(["[Room 1]"]));
    expect(rows(await tools.run("groups.clashes", {}, signal, "t1"), "clashes")).toHaveLength(2);
    expect(rows(await tools.run("followups.unowned", {}, signal, "t1"), "follow_ups")).toHaveLength(1);
    // The copy for other AI apps: the same, with no room's, service's or person's name.
    const copy = JSON.stringify(await sharedEnvelopes(a.tools()));
    expect(copy).toContain("2026-11-25T");
    for (const name of ["Sanctuary", "Youth Night", WEEKEND, ...Object.values(a.data.capture!.names)]) expect(copy).not.toContain(name);
  });

  it("a question naming Youth Night: its own rooms and group meeting, never Sunday's or the church's follow-up", async () => {
    const tools = asked().tools(), scope = [YOUTH];
    const overview = await tools.run("sunday.overview", {}, signal, "t2", scope);
    const kinds = rows(overview, "findings").map(r => r["kind"]);
    expect(kinds.filter(k => k === OVERVIEW_ROOM)).toHaveLength(1);
    expect(kinds.filter(k => k === OVERVIEW_GROUP)).toHaveLength(1);
    expect(kinds).not.toContain(OVERVIEW_FOLLOW_UP);
    // Its own part of the page's count, its room clash and group meeting included.
    const own = sundayShownCount(applyDecisions(brief(youth()), []), otherOperations(weekend(), [youth()], notShared)[0]!.operations);
    expect([payload(overview)["needs_a_decision"], payload(overview)["worth_a_look"]]).toEqual([own.decisions, own.looks]);
    const rooms = await tools.run("rooms.conflicts", {}, signal, "t2", scope);
    expect(payload(rooms)["status"]).toBe("room use needs review");
    expect(rows(rooms, "rooms").map(r => (r["overlap"] as { starts_at: string }).starts_at.slice(0, 10))).toEqual(["2026-11-25"]);
    expect(rows(await tools.run("groups.clashes", {}, signal, "t2", scope), "clashes")).toHaveLength(1);
    // Naming the first service: its own, as before.
    const first = await tools.run("rooms.conflicts", {}, signal, "t3", [WEEKEND]);
    expect(rows(first, "rooms").map(r => (r["overlap"] as { starts_at: string }).starts_at.slice(0, 10))).toEqual(["2026-11-22"]);
  });

  it("a second service on the first's day: the shared room clash is in no answer twice", async () => {
    const tools = asked(true).tools();
    expect(rows(await tools.run("rooms.conflicts", {}, signal, "t4"), "rooms")).toHaveLength(1);
    const own = await tools.run("rooms.conflicts", {}, signal, "t5", [YOUTH]);
    expect(rows(own, "rooms")).toEqual([]);
    // Never "no overlap found" for a day whose rooms are with another service.
    expect(payload(own)["status"]).toBe("not fully checked");
    const overview = await tools.run("sunday.overview", {}, signal, "t6");
    expect(rows(overview, "findings").filter(r => r["kind"] === OVERVIEW_ROOM)).toHaveLength(1);
  });

  it("the open decisions an answer left out: every service's room clash once, a scope's own only, the follow-up with the first", async () => {
    const tools = asked().tools();
    const left = async (scope: string[] = []) => (await decisionsLeftOut(tools, '{"answer":"not-covered"}', [], signal, undefined, scope)).paragraphs.join(" ");
    const all = await left();
    expect(all.match(/has bookings that overlap/gu)).toHaveLength(2);
    expect(all).toContain("has bookings that overlap on 2026-11-22");
    expect(all).toContain("has bookings that overlap on 2026-11-25");
    expect(all.match(/step \[Step 1\]/gu)).toHaveLength(1);
    const youthOnly = await left([YOUTH]);
    expect(youthOnly.match(/has bookings that overlap/gu)).toHaveLength(1);
    expect(youthOnly).toContain("has bookings that overlap on 2026-11-25");
    expect(youthOnly).not.toContain("[Step 1]");
  });

  it("through the real harness: the question goes as labels, the answer names the room and day on this Mac only", async () => {
    const a = asked(), sent: AgentStepRequest[] = [];
    const model: ModelStep = async r => {
      sent.push(r);
      const got = r.messages.flatMap(m => m.role === "tool" ? [JSON.parse(m.content) as { payload: Record<string, unknown> }] : []);
      if (!got.length) return { content: "", tool_calls: [{ id: "call_1_0", name: "sunday.overview", arguments: "{}" }], finish: "tool_calls" };
      const facts = rows(got[0]!, "findings").filter(x => x["kind"] === OVERVIEW_ROOM || x["kind"] === OVERVIEW_GROUP).map(x => x["fact"]);
      return { content: JSON.stringify({ answer: "facts", facts }), tool_calls: [], finish: "stop" };
    };
    const h = new Harness({ workspace_id: "fictional", data: a.data, skills: await bundledSkills(), runtime: new TsLoop(), model, now: () => a.now, newId: () => "00000000-0000-4000-8000-0000000000d1", macZone: "America/New_York" });
    const res = await h.ask("Are the rooms clear at Ozzie Demo Youth Night (fictional)?");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.question).toMatch(/\[Service \d\]/u);
    expect(res.outcome.status).toBe("verified");
    const varying = JSON.stringify(sent.map(r => r.messages.slice(1)));
    for (const name of ["Sanctuary", "Youth Night", WEEKEND, "Lyrics", ...Object.values(a.data.capture!.names)]) expect(varying).not.toContain(name);
    for (const r of sent) expect(pinnedRequestProblems(r, a.data.capture!.names)).toEqual([]);
    const shown = composeAnswer(res.outcome.answer!, res.outcome.evidence, a.data.brief!.day ?? null).paragraphs.map(p => h.restore(p)).join(" ");
    expect(shown).toContain("Sanctuary (fictional) has bookings that overlap");
    expect(shown).toContain("November 25");
    expect(shown).not.toContain("November 22");
  });
});

// Review M2: a "Watch room bookings" or "Group night clashes" card's count and the job's own write-up (built from every
// service, its procedure calling rooms.conflicts or groups.clashes with no scope) say the same rooms and meetings.
describe("Watch room bookings and Group night clashes count what their write-ups read", () => {
  const signal = new AbortController().signal;
  const listed = async (tools: HarnessTools, tool: string, list: string) => ((await tools.run(tool, {}, signal, `job-${tool}`)).payload as Record<string, unknown[]>)[list]!.length;
  const harness = (main: SundayCapture, other: SundayCapture, rules: SundayRules) => {
    const [ops] = otherOperations(main, [other], rules);
    const named = [{ plan_id: other.plan_id, brief: brief(other), name: YOUTH }];
    const m = mergeParts({ brief: brief(main), decisions: [] }, [{ plan_id: other.plan_id, brief: brief(other), decisions: [] }]);
    const firstRooms = firstRoomsWith(main, [other], rules) === null;
    const data: HarnessData = {
      capture: mergedNames(main, [other]), brief: m.brief, operations: sundayOperations(main, rules, firstRooms ? {} : { rooms: false }), decisions: m.decisions, rules, attention: null,
      granted: ["services", "operations"], mode: "live", connected: true, ...askServices({ brief: brief(main), name: WEEKEND }, named),
      alsoOperations: harnessOperations([{ name: YOUTH, operations: ops!.operations, roomsWith: ops!.roomsWith }])!,
    };
    const also = { firstRooms, others: [{ plan_id: other.plan_id, brief: brief(other), decisions: [], operations: ops!.operations }] };
    return { tools: new HarnessTools(data, new HarnessSession(), { now: () => main.completed_at }), also };
  };
  const count = (f: ReturnType<typeof findingsFor>) => (f.findings.rooms ?? 0) + (f.findings.rooms_uncertain ?? 0);

  for (const [name, other] of [["different days", youth], ["the same day", evening]] as const) {
    it(`two services on ${name}: the card's rooms and group meetings are the write-up's`, async () => {
      const h = harness(weekend(), other(), notShared);
      const rooms = findingsFor("watch-room-bookings", weekend(), notShared, weekend().completed_at, [], h.also);
      const groups = findingsFor("group-night-clashes", weekend(), notShared, weekend().completed_at, [], h.also);
      expect(count(rooms)).toBe(await listed(h.tools, "rooms.conflicts", "rooms"));
      expect(groups.findings.groups).toBe(await listed(h.tools, "groups.clashes", "clashes"));
      expect(groups.findings.groups).toBe(2);
      expect(count(rooms)).toBe(name === "the same day" ? 1 : 2);
      // Every key once.
      expect(new Set(rooms.keys).size).toBe(rooms.keys.length);
      expect(new Set(groups.keys).size).toBe(groups.keys.length);
    });
  }

  it("the first service's own room read failed, the evening's didn't: the day's rooms are the evening's, once, on the card as in the write-up", async () => {
    const failed = edit(weekend(), "calendar_resource_bookings", r => { r.outcome = "timeout"; delete r.body; });
    const h = harness(failed, evening(), notShared);
    expect(h.also.firstRooms).toBe(false);
    const rooms = findingsFor("watch-room-bookings", failed, notShared, failed.completed_at, [], h.also);
    expect(count(rooms)).toBe(1);
    expect(count(rooms)).toBe(await listed(h.tools, "rooms.conflicts", "rooms"));
  });

  it("one service: the first service's own, as before", () => {
    expect(count(findingsFor("watch-room-bookings", weekend(), notShared, weekend().completed_at))).toBe(1);
    expect(findingsFor("group-night-clashes", weekend(), notShared, weekend().completed_at).findings.groups).toBe(1);
  });
});

// Review M1 and L3: one function decides which service shows a day's rooms, from each service's latest check, for the page,
// Ask, the jobs and the notices alike.
describe("which service shows a church-local day's rooms (services-merge.ts roomsHolders)", () => {
  const second = () => own(wednesdayWithOperations(), "94000003", "1702");
  const roomsFail = (c: SundayCapture) => edit(c, "calendar_resource_bookings", r => { r.outcome = "timeout"; delete r.body; });

  it("the first service on the day whose latest check read its rooms in full; else the first on that day", () => {
    expect(roomsHolders([weekend(), youth(), second()], notShared)).toEqual([0, 1, 1]);
    // Youth Night's latest check came back without its rooms: the later service's full read shows Wednesday's.
    expect(roomsHolders([weekend(), roomsFail(youth()), second()], notShared)).toEqual([0, 2, 2]);
    // Neither read them: the first on that day says so.
    expect(roomsHolders([weekend(), roomsFail(youth()), roomsFail(second())], notShared)).toEqual([0, 1, 1]);
    // None read yet for Youth Night: the later one.
    expect(roomsHolders([weekend(), null, second()], notShared)).toEqual([0, 1, 2]);
    // Youth Night's last check is out of date (its later checks failed) while the later service's is current: the later
    // one shows the day, so a service whose check keeps failing never hides it (second-pass review M1).
    const later = "2026-11-20T16:30:00Z", fresh = shifted(second(), later);
    expect(roomsHolders([weekend(), youth(), fresh], notShared, later)).toEqual([0, 2, 2]);
    // Both current: the first on that day. Both out of date: the first that read the day in full.
    expect(roomsHolders([weekend(), shifted(youth(), later), fresh], notShared, later)).toEqual([0, 1, 1]);
    expect(roomsHolders([weekend(), youth(), second()], notShared, "2026-11-21T15:00:00Z")).toEqual([0, 1, 1]);
    // The first service's own read failed, a same-day service's didn't: the first leaves the day to it.
    expect(roomsHolders([roomsFail(weekend()), evening()], notShared)).toEqual([1, 1]);
    expect(firstRoomsWith(roomsFail(weekend()), [evening()], notShared)).toBe(1);
    expect(firstRoomsWith(weekend(), [evening()], notShared)).toBeNull();
    expect(firstRoomsWith(weekend(), [], notShared)).toBeNull();
  });

  it("every part's lines name the service that really shows the day: the first service's part too", () => {
    const failed = roomsFail(weekend());
    const [e] = otherOperations(failed, [evening()], notShared);
    expect(e!.roomsWith).toBeNull();
    expect(kinds(e!.operations)).toEqual(["room-overlap"]);
    // The first service's own check, without that day's rooms: its follow-up still, and the line saying where the rooms are.
    const first = sundayOperations(failed, notShared, { rooms: false })!;
    expect(kinds(first)).toEqual(["unowned-overdue"]);
    const t = text(renderToStaticMarkup(React.createElement(SundayPage, {
      brief: brief(failed), names: failed.names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true, canReword: false,
      decisions: [], onDecisions: () => undefined, operations: first, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
      part: { name: WEEKEND, waiting: null, roomsWith: "Evening Prayer" },
    })));
    expect(t).toContain(roomsWithLine("Evening Prayer"));
    expect(t).not.toContain("has overlapping bookings");
    expect(t).not.toContain("Room bookings: took too long.");
  });

  it("review L4: Ask's What wasn't checked says where a same-day service's rooms are, and when another service read none of them", async () => {
    const signal = new AbortController().signal;
    const data = (other: SundayCapture, ops: SundayOperations | null, roomsWith: number | null): HarnessData => {
      const named = [{ plan_id: other.plan_id, brief: brief(other), name: YOUTH }];
      const m = mergeParts({ brief: brief(weekend()), decisions: [] }, [{ plan_id: other.plan_id, brief: brief(other), decisions: [] }]);
      return { capture: mergedNames(weekend(), [other]), brief: m.brief, operations: sundayOperations(weekend(), notShared), decisions: m.decisions, rules: notShared, attention: null,
        granted: ["services", "operations"], mode: "live", connected: true, ...askServices({ brief: brief(weekend()), name: WEEKEND }, named),
        alsoOperations: harnessOperations([{ name: YOUTH, operations: ops, roomsWith }])! };
    };
    const lines = async (d: HarnessData) => ((await new HarnessTools(d, new HarnessSession(), { now: () => weekend().completed_at })
      .run("sunday.not_checked", {}, signal, "l4", [YOUTH])).payload as Record<string, unknown>)["rooms_follow_ups_groups"];
    const [e] = otherOperations(weekend(), [evening()], notShared);
    expect(await lines(data(evening(), e!.operations, e!.roomsWith))).toEqual(["Room bookings for this service are shown in another service."]);
    expect(await lines(data(own(wednesdayCapture(), "94000004", "1704"), null, null))).toEqual(["Room bookings and group meetings weren't part of this check."]);
  });
});
