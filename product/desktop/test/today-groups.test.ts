// Today's three groups and setting an item aside, on fixed fictional data. Which item goes where is
// decided by its state alone (today-groups.ts); these tests pin each rule.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { evaluateAttentionImport, type Message } from "../../../core/src/attention-import/index.js";
import { harborAttentionImport } from "../../../core/src/fictional-attention.js";
import { defaultPlan, TEMPLATES, type Responsibility } from "../../../core/src/harness/responsibilities.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, openCount } from "../../../core/src/sunday-decisions.js";
import type { NoticedItem, RunnerView, WriteUp } from "../src/responsibility-runner.js";
import { copyText, NoticedCard } from "../src/responsibility-views.js";
import { preparedTitle } from "../src/responsibility-words.js";
import {
  ageText, backText, CAN_SET_ASIDE, countText, decisionLines, DECISIONS_NAMED, GROUP_OF, groupToday, ledeText, notesReadyText, pageNotes, progressEmptyText, regularLine, regularMissedText, reportState,
  setAsideChoices, sundayCount, sundayCountText, todayItems, todayMemory, type RegularCheck, type TodayInput, type TodayItem,
} from "../src/today-groups.js";
import { TodayPage } from "../src/today-page.js";
import { HIDDEN_WORDS, text } from "./harness-fakes.js";

const ET = "America/New_York";
const FRI = "2026-11-20T15:00:00.000Z"; // Friday 10:00 AM in New York
const capture = nov22Capture();
const names = capture.names;
const brief = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true);
const report = evaluateAttentionImport(harborAttentionImport());
if (!report.ok) throw new Error("fixture");
const attention = { findings: report.findings, messages: report.sources.filter((s): s is Message => "subject" in s), evaluated_at: report.evaluated_at, zone: ET };

const KEEP = "00000000-0000-4000-8000-000000000001", ROOMS = "00000000-0000-4000-8000-000000000002", BRIEF = "00000000-0000-4000-8000-000000000003";
const ENDED = "00000000-0000-4000-8000-000000000004";
function responsibility(id: string, template: keyof typeof TEMPLATES, over: Partial<Responsibility> = {}): Responsibility {
  const t = TEMPLATES[template];
  return { ...defaultPlan(template, FRI, ET), id, title: t.title, skill_id: t.skill_id, status: "active", created_at: "2026-11-17T14:00:00.000Z",
    confirmed_at: "2026-11-17T14:00:00.000Z", runs: [], open_run: null, ...over };
}
const noticedItem = (over: Partial<NoticedItem> & Pick<NoticedItem, "id" | "responsibility_id" | "kind">): NoticedItem =>
  ({ template: "keep-sunday-covered", at: FRI, ...over });
const view = (over: Partial<RunnerView> = {}): RunnerView => ({
  available: true, paused_all: false, items: [], noticed: [], writeups: {}, next: {}, running: null, unseen: 0, open_today: false, ...over,
});
/** A job's write-up as the runner keeps it: people as id tokens (501 is Avery Brightwater in the fictional Sunday). */
const writeup = (item: string, over: Partial<WriteUp> & { none?: true } = {}): WriteUp => over.none
  ? { item, responsibility_id: KEEP, run_id: "00000000-0000-4000-8000-0000000000aa", organization: capture.organization, at: over.at ?? "2026-11-20T14:00:04.000Z", kind: "none", why: over.why ?? "off" }
  : ({
  item, responsibility_id: KEEP, run_id: "00000000-0000-4000-8000-0000000000aa", organization: capture.organization, at: "2026-11-20T14:00:04.000Z", kind: "written",
  lines: ["For Sunday November 22, this check found 2 items that need a decision and 2 worth a look.", "{{person:501}} hasn't accepted Greeter yet."],
  based_on: "Based on: Planning Center Services, checked Fri, Nov 20, 9:00 AM", gaps: [], steps: ["Looked at this Sunday's overview — all of it"], ai_steps: 2, ...over,
});
const input = (over: Partial<TodayInput> = {}): TodayInput => ({ now: FRI, attention: null, sunday: null, watch: null, firstSeen: {}, ...over });
const sundayAt = (checked_at: string, decisions = 2, answers: string[] = []) => ({ plan_id: "92902197", checked_at, decisions, answers });
const groupsOf = (items: TodayItem[]) => Object.fromEntries(items.map(i => [i.id, GROUP_OF[i.state]]));
/** The fictional email's item id: its finding id (JSON) in the characters kept on this Mac. */
const EMAIL = "email:_harbor_office_CAL-01_location-unavailable_";
/** The same Sunday, with Planning Center recording that the pending Lyrics request was sent. */
const sentBrief: SundayBrief = { ...brief, findings: brief.findings.map(f => f.kind === "pending" ? { ...f, notification: "sent" as const } : f) };
const memoryStore = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed));
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); }, raw: m };
};

describe("which group an item is in", () => {
  it("is decided by its state alone, and only what waits on the person can be set aside", () => {
    expect(GROUP_OF).toEqual({ "needs-decision": "attention", "needs-you": "attention", prepared: "review", "waiting-answer": "progress", "under-way": "progress" });
    expect(CAN_SET_ASIDE).toEqual({ attention: true, review: true, progress: false });
  });

  it("puts a finding that needs a decision in Needs your attention, prepared work in Ready to review, and work under way in In progress", () => {
    const checked = "2026-11-20T14:00:00.000Z";
    const items = todayItems(input({
      attention, sunday: sundayAt(checked, 2, ["Lyrics"]),
      watch: view({
        items: [responsibility(KEEP, "keep-sunday-covered"), responsibility(ROOMS, "watch-room-bookings"), responsibility(BRIEF, "morning-briefing")],
        noticed: [
          noticedItem({ id: "keep-found", responsibility_id: KEEP, kind: "found", decisions: 2, drafts: 1, at: "2026-11-20T14:00:04.000Z", check: { plan_id: "92902197", completed_at: checked } }),
          noticedItem({ id: "rooms-found", responsibility_id: ROOMS, template: "watch-room-bookings", kind: "found", findings: { rooms: 1 } }),
          noticedItem({ id: "briefing", responsibility_id: BRIEF, template: "morning-briefing", kind: "briefing" }),
        ],
        writeups: { "keep-found": writeup("keep-found"), "rooms-found": writeup("rooms-found", { responsibility_id: ROOMS }) },
      }),
    }));
    expect(groupsOf(items)).toEqual({
      [EMAIL]: "attention",
      // Sunday's decisions, and Keep Sunday covered's write-up of them, are on the Sunday card.
      "sunday:92902197": "attention",
      // A write-up never moves a report out of Needs your attention.
      "noticed:rooms-found": "attention",
      "noticed:briefing": "review",
      [`watching:${KEEP}`]: "progress", [`watching:${ROOMS}`]: "progress", [`watching:${BRIEF}`]: "progress",
      "answers:92902197": "progress",
    });
    // Every item is in exactly one group, so the three counts add up to the items.
    const g = groupToday(items, {}, FRI);
    expect(g.attention.length + g.review.length + g.progress.length).toBe(items.length);
    expect(new Set(items.map(i => i.id)).size).toBe(items.length);
  });

  it("treats a report as prepared only for a briefing or notes ready on the Sunday page, never because of a write-up", () => {
    const found = noticedItem({ id: "f", responsibility_id: KEEP, kind: "found", decisions: 1 });
    expect(reportState(found)).toBe("needs-decision");
    expect(reportState.length).toBe(1);
    expect(reportState({ ...found, drafts: 1 })).toBe("prepared");
    expect(reportState(noticedItem({ id: "b", responsibility_id: BRIEF, kind: "briefing" }))).toBe("prepared");
  });

  it("shows something Ozzie noticed about Sunday with nothing prepared on the Sunday card instead of counting it twice", () => {
    const found = noticedItem({ id: "keep-found", responsibility_id: KEEP, kind: "found", decisions: 2, at: "2026-11-20T13:00:00.000Z" });
    const watch = view({ items: [responsibility(KEEP, "keep-sunday-covered")], noticed: [found] });
    // The check on screen is newer: the card carries the report.
    const folded = todayItems(input({ watch, sunday: sundayAt("2026-11-20T14:00:00.000Z") }));
    expect(folded.filter(i => GROUP_OF[i.state] === "attention").map(i => i.id)).toEqual(["sunday:92902197"]);
    expect(folded[0]!.subject).toMatchObject({ type: "sunday", decisions: 2, noticed: { id: "keep-found" } });
    // The person has decided everything on Sunday since: the old report isn't shown at all.
    const decided = todayItems(input({ watch, sunday: sundayAt("2026-11-20T14:00:00.000Z", 0) }));
    expect(decided.filter(i => GROUP_OF[i.state] === "attention")).toEqual([]);
    // No check on screen yet: the report is its own item.
    const alone = todayItems(input({ watch }));
    expect(alone.filter(i => GROUP_OF[i.state] === "attention").map(i => i.id)).toEqual(["sunday-unchecked", "noticed:keep-found"]);
  });

  it("keeps only each responsibility's newest report; a later check that found nothing new doesn't resolve it", () => {
    const older = noticedItem({ id: "old", responsibility_id: ROOMS, template: "watch-room-bookings", kind: "found", findings: { rooms: 1 }, at: "2026-11-19T15:00:00.000Z" });
    const newer = { ...older, id: "new", findings: { rooms: 2 }, at: "2026-11-20T12:00:00.000Z" };
    const clear = noticedItem({ id: "clear", responsibility_id: ROOMS, template: "watch-room-bookings", kind: "clear", at: "2026-11-20T14:00:00.000Z" });
    const items = todayItems(input({ watch: view({ items: [responsibility(ROOMS, "watch-room-bookings")], noticed: [clear, newer, older] }) }));
    expect(items.filter(i => i.subject.type === "noticed").map(i => i.id)).toEqual(["noticed:new"]);
  });

  it("leaves out reports from a responsibility that has ended", () => {
    const items = todayItems(input({ watch: view({
      items: [responsibility(ENDED, "keep-sunday-covered", { status: "ended" })],
      noticed: [noticedItem({ id: "x", responsibility_id: ENDED, kind: "found", decisions: 1, drafts: 1 })],
    }) }));
    expect(items.map(i => i.id)).toEqual(["sunday-unchecked"]);
  });

  it("asks the person to add access only until a later check finishes; other problems stay on the card in In progress", () => {
    const keep = responsibility(KEEP, "keep-sunday-covered");
    const access = noticedItem({ id: "access", responsibility_id: KEEP, kind: "couldnt-check", code: "denied", access: true, at: "2026-11-20T14:00:00.000Z" });
    const missed = noticedItem({ id: "missed", responsibility_id: KEEP, kind: "missed", scheduled_for: "2026-11-20T12:00:00.000Z", missed_reason: "asleep", at: "2026-11-20T14:30:00.000Z" });
    const failed = noticedItem({ id: "failed", responsibility_id: KEEP, kind: "couldnt-check", code: "provider-failure", at: "2026-11-20T14:40:00.000Z" });
    const old = noticedItem({ id: "old-missed", responsibility_id: KEEP, kind: "missed", at: "2026-11-18T14:30:00.000Z" });
    const items = todayItems(input({ sunday: sundayAt(FRI, 0), watch: view({ items: [keep], noticed: [failed, missed, access, old] }) }));
    expect(groupsOf(items)).toEqual({ "noticed:access": "attention", [`watching:${KEEP}`]: "progress" });
    const card = items.find(i => i.id === `watching:${KEEP}`)!.subject;
    // The newest two problems from the last day; older ones are on What runs automatically.
    expect(card.type === "watching" && card.notes.map(n => n.id)).toEqual(["failed", "missed"]);
    const later = noticedItem({ id: "ok", responsibility_id: KEEP, kind: "clear", at: "2026-11-20T14:50:00.000Z" });
    expect(todayItems(input({ sunday: sundayAt(FRI, 0), watch: view({ items: [keep], noticed: [later, access] }) })).map(i => i.id)).toEqual([`watching:${KEEP}`]);
  });

  it("puts Sunday not checked yet in Needs your attention with no age, and Planning Center requests waiting for an answer in In progress", () => {
    const none = todayItems(input());
    expect(none).toEqual([{ id: "sunday-unchecked", state: "needs-you", since: null, subject: { type: "sunday-unchecked" } }]);
    const answers = todayItems(input({ sunday: sundayAt(FRI, 0, ["Lyrics"]), firstSeen: { "answers:92902197": "2026-11-18T15:00:00.000Z" } }));
    expect(answers).toEqual([{ id: "answers:92902197", state: "waiting-answer", since: "2026-11-18T15:00:00.000Z", subject: { type: "answers", positions: ["Lyrics"] } }]);
  });

  it("measures the fictional email on its own fixed clock, from when its email arrived", () => {
    const [email] = todayItems(input({ attention }));
    expect(email!.since).toBe("2026-11-19T13:15:00Z");
    expect(email!.clock).toEqual({ now: "2026-11-19T14:00:00Z", zone: ET });
    expect(ageText(email!, email!.clock!.now, ET)).toBe("Waiting since 8:15 AM");
  });
});

describe("Sunday's decisions show once", () => {
  const CHECKED = "2026-11-20T14:00:00.000Z";
  const sameCheck = { plan_id: "92902197", completed_at: CHECKED };
  // A report is written a moment after the check it read has finished.
  const report = (over: Partial<NoticedItem> = {}) => noticedItem({
    id: "keep-found", responsibility_id: KEEP, kind: "found", decisions: 2, looks: 1, drafts: 1, at: "2026-11-20T14:00:04.000Z", check: sameCheck, ...over,
  });
  const keepWatch = (over: Partial<RunnerView> = {}) => view({ items: [responsibility(KEEP, "keep-sunday-covered")], noticed: [report()], ...over });
  const notProgress = (items: TodayItem[]) => items.filter(i => GROUP_OF[i.state] !== "progress").map(i => i.id);

  it("folds a Keep Sunday covered report read by the same check into the Sunday card, with its notes", () => {
    const items = todayItems(input({ watch: keepWatch(), sunday: sundayAt(CHECKED) }));
    expect(notProgress(items)).toEqual(["sunday:92902197"]);
    expect(items[0]!.subject).toMatchObject({ type: "sunday", decisions: 2, noticed: { id: "keep-found", drafts: 1 } });
    // Notes ready on the Sunday page are the report's notes, less the one the AI drafted (shown on its own).
    expect(pageNotes(report())).toBe(1);
    expect(pageNotes(report({ drafts: 2, drafted: true }))).toBe(1);
    expect(pageNotes(report({ drafts: 0 }))).toBe(0);
    expect(notesReadyText(1)).toBe("Ozzie has a note ready for these on the Sunday page. Nothing has been sent.");
    expect(notesReadyText(2)).toBe("Ozzie has 2 notes ready for these on the Sunday page. Nothing has been sent.");
  });

  it("puts Keep Sunday covered's write-up on the Sunday card, never as an item of its own", () => {
    const w = writeup("keep-found");
    const items = todayItems(input({ watch: keepWatch({ writeups: { "keep-found": w } }), sunday: sundayAt(CHECKED) }));
    expect(groupsOf(items)).toEqual({ "sunday:92902197": "attention", [`watching:${KEEP}`]: "progress" });
    expect(items[0]!.subject).toMatchObject({ type: "sunday", noticed: { id: "keep-found" }, writeup: w });
    // Why there is none goes on the card the same way.
    const none = writeup("keep-found", { none: true, why: "off" });
    expect(todayItems(input({ watch: keepWatch({ writeups: { "keep-found": none } }), sunday: sundayAt(CHECKED) }))[0]!.subject).toMatchObject({ writeup: none });
    expect(preparedTitle({ summary: null, draft: "Hi" })).toBe("Ozzie drafted a note for Sunday.");
  });

  it("leaves a report about another Sunday, or read by a newer check than the card's, as its own item", () => {
    const other = todayItems(input({ watch: keepWatch({ noticed: [report({ check: { plan_id: "93000000", completed_at: CHECKED } })] }), sunday: sundayAt(CHECKED) }));
    expect(notProgress(other)).toEqual(["sunday:92902197", "noticed:keep-found"]);
    const later = report({ check: { ...sameCheck, completed_at: "2026-11-20T14:30:00.000Z" }, at: "2026-11-20T14:30:04.000Z" });
    expect(notProgress(todayItems(input({ watch: keepWatch({ noticed: [later] }), sunday: sundayAt(CHECKED) })))).toEqual(["sunday:92902197", "noticed:keep-found"]);
    // A check on screen that is newer than the report's still carries it.
    expect(notProgress(todayItems(input({ watch: keepWatch(), sunday: sundayAt("2026-11-20T15:00:00.000Z") })))).toEqual(["sunday:92902197"]);
  });

  it("drops the report, and what the AI wrote for it, once nothing on Sunday needs a decision", () => {
    const items = todayItems(input({ watch: keepWatch({ writeups: { "keep-found": writeup("keep-found") } }), sunday: sundayAt(CHECKED, 0) }));
    expect(items.map(i => i.id)).toEqual([`watching:${KEEP}`]);
  });

  it("on screen, the Sunday card leads with Keep Sunday covered's write-up, then the fixed decisions; or says quietly why there is no write-up", () => {
    const check = { plan_id: brief.plan.id, completed_at: brief.completed_at };
    const watchWith = (w: WriteUp) => ({ view: keepWatch({ noticed: [report({ check, at: FRI, overnight: true })], writeups: { "keep-found": w } }),
      now: FRI, onAutomatic: () => {}, onOpen: () => {} });
    const html = renderToStaticMarkup(React.createElement(TodayPage, { brief, names, onSunday: () => {}, now: FRI, zone: ET, store: memoryStore(), watch: watchWith(writeup("keep-found", { at: FRI })) }));
    const page = text(html);
    const attention = page.slice(page.indexOf("Needs your attention"), page.indexOf("Ready to review"));
    // Names are filled in on this Mac from the check on screen; the stored write-up holds only the id.
    expect(attention).toMatch(new RegExp(`Sunday has 2 things to decide\\. Ozzie checked Sunday at ${new Date(FRI).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}: For Sunday November 22, this check found 2 items that need a decision and 2 worth a look\\. Avery Brightwater hasn't accepted Greeter yet\\. Based on: Planning Center Services, checked Fri, Nov 20, 9:00 AM See how this works Greeter: `, "u"));
    expect(attention).toMatch(/Ozzie noticed this at .+ while keeping an eye on Sunday\. Notes ready Ozzie has a note ready for these on the Sunday page\. Nothing has been sent\. Open Sunday/u);
    expect(html).not.toContain("Read Ozzie&#x27;s write-up");
    // No extra item: the write-up is on the card it belongs to.
    expect(page).toContain("Ready to review 0 items");
    expect(page).not.toMatch(HIDDEN_WORDS);
    // AI help set up but no write-up this run: one quiet line says why, and the fixed decisions are as before.
    const spent = text(renderToStaticMarkup(React.createElement(TodayPage, { brief, names, onSunday: () => {}, now: FRI, zone: ET, store: memoryStore(),
      watch: watchWith(writeup("keep-found", { none: true, why: "spent" })) })));
    expect(spent).toMatch(/Sunday has 2 things to decide\. No write-up this time: AI help has reached its limit for now\. This card shows what Ozzie's own check of Planning Center found\. Greeter: /u);
    const bare = page.replace(/Ozzie checked Sunday at .+? See how this works /u, "");
    // One run's own limit is not the allowance (review G).
    const ranPast = text(renderToStaticMarkup(React.createElement(TodayPage, { brief, names, onSunday: () => {}, now: FRI, zone: ET, store: memoryStore(),
      watch: watchWith(writeup("keep-found", { none: true, why: "run-limit" })) })));
    expect(ranPast).toContain("No write-up this time: the AI's answer ran past what one run may use. This card shows what Ozzie's own check of Planning Center found.");
    expect(ranPast).not.toContain("reached its limit");
    // Paused during its write-up: none is kept, and nothing is said (review G).
    const paused = renderToStaticMarkup(React.createElement(TodayPage, { brief, names, onSunday: () => {}, now: FRI, zone: ET, store: memoryStore(),
      watch: watchWith(writeup("keep-found", { none: true, why: "stopped" })) }));
    expect(paused).not.toContain("writeup-none");
    expect(text(paused)).toBe(bare);
    expect(spent.replace(/No write-up this time: [^.]+\. This card shows what Ozzie's own check of Planning Center found\. /u, "")).toBe(bare);
    // No AI route set up: no line at all, just the check (review H, L15).
    const off = text(renderToStaticMarkup(React.createElement(TodayPage, { brief, names, onSunday: () => {}, now: FRI, zone: ET, store: memoryStore(),
      watch: watchWith(writeup("keep-found", { none: true, why: "off" })) })));
    expect(off).not.toContain("No write-up this time");
    expect(off).toBe(bare);
  });
});

describe("Sunday's count", () => {
  it("is things to decide wherever it shows (the sidebar, the Sunday card); Worth a look is counted apart, never added in", () => {
    const open = openCount(applyDecisions(brief, []));
    expect(open).toMatchObject({ decisions: 2, looks: 2 });
    expect(sundayCount(open)).toBe(2);
    expect(sundayCount(null)).toBe(0);
    expect(sundayCountText(2)).toBe("2 things to decide");
    expect(sundayCountText(1)).toBe("1 thing to decide");
    const page = text(renderToStaticMarkup(React.createElement(TodayPage, { brief, names, onSunday: () => {}, now: FRI, zone: ET, store: memoryStore() })));
    expect(page).toContain(`Sunday has ${sundayCountText(sundayCount(open))}.`);
  });
});

describe("ages in plain words", () => {
  const waiting = (since: string) => ageText({ since, state: "needs-decision" }, FRI, ET);
  it("counts calendar days on the given clock", () => {
    expect(waiting("2026-11-20T13:15:00.000Z")).toBe("Waiting since 8:15 AM");
    expect(waiting("2026-11-20T05:30:00.000Z")).toBe("Waiting since 12:30 AM");
    expect(waiting("2026-11-20T04:30:00.000Z")).toBe("Waiting since yesterday"); // 11:30 PM Thursday in New York
    expect(waiting("2026-11-16T15:00:00.000Z")).toBe("Waiting 4 days");
    // Across the end of daylight saving time (November 1) it is still whole days.
    expect(ageText({ since: "2026-10-31T16:00:00.000Z", state: "prepared" }, "2026-11-02T17:00:00.000Z", ET)).toBe("Waiting 2 days");
  });
  it("says Started for work under way, and never shows a time in the future or an unknown one", () => {
    expect(ageText({ since: "2026-11-17T14:00:00.000Z", state: "under-way" }, FRI, ET)).toBe("Started 3 days ago");
    expect(ageText({ since: "2026-11-19T14:00:00.000Z", state: "under-way" }, FRI, ET)).toBe("Started yesterday");
    expect(ageText({ since: "2026-11-20T14:00:00.000Z", state: "under-way" }, FRI, ET)).toBe("Started at 9:00 AM");
    expect(waiting("2026-11-21T15:00:00.000Z")).toBe("Waiting since 10:00 AM");
    expect(ageText({ since: null, state: "needs-you" }, FRI, ET)).toBeNull();
    expect(ageText({ since: "not a time", state: "needs-you" }, FRI, ET)).toBeNull();
  });
});

describe("setting an item aside", () => {
  it("offers tomorrow and Monday, each from the start of that day on this Mac's clock", () => {
    expect(setAsideChoices(FRI, ET)).toEqual([
      { label: "Set aside until tomorrow", until: "2026-11-21T05:00:00.000Z" },
      { label: "Set aside until Monday", until: "2026-11-23T05:00:00.000Z" },
    ]);
    // Sunday: tomorrow is Monday, so it is offered once.
    expect(setAsideChoices("2026-11-22T15:00:00.000Z", ET)).toEqual([{ label: "Set aside until tomorrow", until: "2026-11-23T05:00:00.000Z" }]);
    // Monday: the Monday choice is next week's.
    expect(setAsideChoices("2026-11-23T15:00:00.000Z", ET)[1]).toEqual({ label: "Set aside until next Monday", until: "2026-11-30T05:00:00.000Z" });
    // Saturday October 31: tomorrow starts before daylight saving time ends that night.
    expect(setAsideChoices("2026-10-31T15:00:00.000Z", ET)[0]!.until).toBe("2026-11-01T04:00:00.000Z");
    expect(backText("2026-11-21T05:00:00.000Z", FRI, ET)).toBe("Back tomorrow");
    expect(backText("2026-11-23T05:00:00.000Z", FRI, ET)).toBe("Back Monday");
    expect(backText("2026-11-30T05:00:00.000Z", "2026-11-23T15:00:00.000Z", ET)).toBe("Back Monday, November 30");
  });

  it("takes an item out of its group until its time, then brings it back on time with its age", () => {
    const items = todayItems(input({ attention, sunday: sundayAt(FRI, 2), firstSeen: { "sunday:92902197": "2026-11-16T15:00:00.000Z" },
      watch: view({ items: [responsibility(KEEP, "keep-sunday-covered")] }) }));
    const until = "2026-11-23T05:00:00.000Z";
    const aside = groupToday(items, { "sunday:92902197": until, [`watching:${KEEP}`]: until }, FRI);
    expect(aside.attention.map(i => i.id)).toEqual([EMAIL]);
    expect(aside.setAside.map(e => e.item.id)).toEqual(["sunday:92902197"]);
    // Work under way can't be set aside: it stays in In progress.
    expect(aside.progress.map(i => i.id)).toEqual([`watching:${KEEP}`]);
    expect(groupToday(items, { "sunday:92902197": until }, "2026-11-23T04:59:59.999Z").setAside).toHaveLength(1);
    const back = groupToday(items, { "sunday:92902197": until }, until);
    expect(back.setAside).toEqual([]);
    expect(back.attention.map(i => i.id)).toContain("sunday:92902197");
    expect(ageText(back.attention.find(i => i.id === "sunday:92902197")!, until, ET)).toBe("Waiting 7 days");
  });

  it("is kept on this Mac by id and time only, forgets what's already back, and ignores anything malformed", () => {
    const store = memoryStore();
    const memory = todayMemory(store);
    memory.setAsideUntil("sunday:92902197", "2026-11-21T05:00:00.000Z", FRI);
    memory.setAsideUntil("noticed:a:2026-11-20T15:00:00.000Z:found", "2026-11-23T05:00:00.000Z", FRI);
    expect(todayMemory(store).setAside()).toEqual({ "sunday:92902197": "2026-11-21T05:00:00.000Z", "noticed:a:2026-11-20T15:00:00.000Z:found": "2026-11-23T05:00:00.000Z" });
    // A day later the first is back; the next write forgets it.
    expect(memory.setAsideUntil("email:FIND-1", "2026-11-23T05:00:00.000Z", "2026-11-21T15:00:00.000Z")).toEqual({
      "noticed:a:2026-11-20T15:00:00.000Z:found": "2026-11-23T05:00:00.000Z", "email:FIND-1": "2026-11-23T05:00:00.000Z" });
    expect(memory.bringBack("email:FIND-1")).toEqual({ "noticed:a:2026-11-20T15:00:00.000Z:found": "2026-11-23T05:00:00.000Z" });
    const stored = store.raw.get("ozzie.today.set-aside.v1")!;
    for (const name of Object.values(names)) expect(stored).not.toContain(name);
    for (const junk of ["{", JSON.stringify({ version: 2, items: { "sunday:1": FRI } }), JSON.stringify({ version: 1, items: { "Avery Brightwater": FRI, "sunday:1": "soon" } })]) {
      expect(todayMemory(memoryStore({ "ozzie.today.set-aside.v1": junk })).setAside()).toEqual({});
    }
  });

  it("notes when an item was first on Today, once", () => {
    const store = memoryStore();
    const memory = todayMemory(store);
    expect(memory.noteSeen(["sunday:92902197"], FRI)).toEqual({ "sunday:92902197": FRI });
    expect(memory.noteSeen(["sunday:92902197"], "2026-11-21T15:00:00.000Z")).toBeNull();
    // A month later, one that isn't on Today any more is forgotten.
    expect(memory.noteSeen(["sunday:93000000"], "2026-12-25T15:00:00.000Z")).toEqual({ "sunday:93000000": "2026-12-25T15:00:00.000Z" });
  });
});

describe("Today on screen", () => {
  // The fictional example, as it shows once the person chose it: its invented email and calendar items with it.
  const render = (props: Partial<React.ComponentProps<typeof TodayPage>> = {}) => text(renderToStaticMarkup(React.createElement(TodayPage, {
    brief, names, onSunday: () => {}, now: FRI, zone: ET, store: memoryStore(), example: true, ...props,
  })));

  it("says Sunday's things to decide with the Sunday page's own count, rooms and follow-ups included", () => {
    const example = withFictionalOperations(capture);
    const operations = sundayOperations(example, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, {});
    // Two open roles and the follow-up without an owner; the unconfirmed room overlap and the group meeting are Worth a look, not added in.
    expect(render({ operations })).toContain("Sunday has 3 things to decide.");
    expect(render()).toContain("Sunday has 2 things to decide.");
  });

  it("shows the three groups in order, each with a count of items, never people", () => {
    const page = render();
    const at = (s: string) => page.indexOf(s);
    expect(at("Needs your attention 2 items")).toBeGreaterThan(-1);
    expect(at("Ready to review 0 items")).toBeGreaterThan(at("Needs your attention"));
    expect(at("In progress 0 items")).toBeGreaterThan(at("Ready to review"));
    expect(page).toContain("2 things need your attention.");
    expect(page).not.toMatch(/\b\d+ (?:people|persons|volunteers)\b/u);
    expect(page).not.toMatch(HIDDEN_WORDS);
    expect(page).not.toMatch(/\b(?:approve|block|all clear|at risk|drifting|score|rank)\b/iu);
  });

  it("gives each waiting card its age and the two set-aside choices; work under way has none", () => {
    const page = render();
    const attention = page.slice(page.indexOf("Needs your attention"), page.indexOf("Ready to review"));
    expect(attention).toContain("Tonight's orientation needs a location decision.");
    expect(attention).toContain("Waiting since 8:15 AM");
    expect(attention).toContain("Sunday has 2 things to decide.");
    expect(attention.match(/Set aside until tomorrow/gu)).toHaveLength(2);
    expect(attention.match(/Set aside until Monday/gu)).toHaveLength(2);
    expect(attention).toContain("Fictional import: invented email and calendar records");
    const sent = render({ brief: sentBrief });
    const progress = sent.slice(sent.indexOf("In progress"), sent.indexOf("Listen to today"));
    expect(progress).toMatch(/In progress 1 item Waiting for an answer Planning Center Services Waiting since 10:00 AM Waiting for an answer in Planning Center/u);
    expect(progress).toContain("Planning Center shows a request was sent for Lyrics and hasn't been accepted yet.");
    expect(progress).not.toContain("Set aside");
  });

  it("keeps a set-aside item out of its group, folded away with when it comes back", () => {
    const store = memoryStore();
    todayMemory(store).setAsideUntil(`sunday:${brief.plan.id}`, "2026-11-23T05:00:00.000Z", FRI);
    const page = render({ store });
    const attention = page.slice(page.indexOf("Needs your attention"), page.indexOf("Ready to review"));
    expect(attention).toContain("Needs your attention 1 item");
    expect(attention).not.toContain("Sunday has 2 things to decide.");
    expect(page).toMatch(/Set aside for now 1 item Sunday has 2 things to decide\. Back Monday Bring it back now/u);
    // Monday morning it is back where it was.
    const monday = render({ store, now: "2026-11-23T05:00:00.000Z" });
    expect(monday.slice(monday.indexOf("Needs your attention"), monday.indexOf("Ready to review"))).toContain("Sunday has 2 things to decide.");
    expect(monday).not.toContain("Set aside for now");
  });

  it("counts any kind of Sunday finding that needs a decision, and says plainly when nothing does", () => {
    const extra = { ...brief.findings.find(f => f.tone === "decision")!, id: "kind-from-elsewhere", key: "[\"elsewhere\"]", kind: "a-new-kind" } as unknown as SundayBrief["findings"][number];
    expect(render({ brief: { ...brief, findings: [...brief.findings, extra] } })).toContain("Sunday has 3 things to decide.");
    const calm = render({ brief: { ...brief, findings: brief.findings.filter(f => f.tone !== "decision") } });
    expect(calm).toContain("Nothing on Sunday needs a decision.");
    expect(calm).toContain("Needs your attention 1 item");
  });

  it("says each group is empty in plain words", () => {
    const store = memoryStore();
    todayMemory(store).setAsideUntil(EMAIL, "2026-11-21T05:00:00.000Z", FRI);
    const page = render({ store, brief: { ...brief, findings: [] } });
    expect(page).toContain("Nothing needs your attention right now.");
    expect(page).toContain("Nothing to review. Briefings and notes Ozzie prepares will be here.");
    // Never "nothing is under way" while the regular check runs, and never a pointer to Ask (audit item 4).
    expect(page).toContain("In progress 0 items Nothing runs in the fictional example.");
    expect(page).not.toMatch(/under way|Ask Ozzie/u);
    expect(page).toContain("Nothing needs you right now.");
  });
});

describe("a note Ozzie drafted while keeping an eye on things", () => {
  const item = noticedItem({ id: "a", responsibility_id: KEEP, kind: "found", decisions: 1 });
  it("has a Copy draft button beside the draft, which still says nothing has been sent", () => {
    const html = renderToStaticMarkup(React.createElement(NoticedCard, {
      item, view: view(), written: { summary: null, draft: "Hi Avery,\n\nCould you greet on Sunday?" }, names, now: FRI, onOpen: () => {}, titleId: "t",
    }));
    expect(text(html)).toMatch(/Draft only\. Nothing has been sent\. Hi Avery, Could you greet on Sunday\? Copy draft/u);
    expect(html).toContain("aria-describedby=\"t\"");
  });
  it("counts a copy only when the clipboard took it", async () => {
    expect(await copyText("note", undefined)).toBe(false);
    expect(await copyText("note", { writeText: () => Promise.reject(new Error("denied")) })).toBe(false);
    let copied = "";
    expect(await copyText("note", { writeText: async t => { copied = t; } })).toBe(true);
    expect(copied).toBe("note");
  });
  it("ledes and counts are items", () => {
    expect(countText(1)).toBe("1 item");
    expect(countText(3)).toBe("3 items");
    const one = [{} as TodayItem];
    expect(ledeText({ attention: one, review: [], progress: one })).toBe("1 thing needs your attention.");
    expect(ledeText({ attention: [], review: [...one, ...one], progress: [] })).toBe("2 are ready to review.");
    expect(ledeText({ attention: [], review: [], progress: one })).toBe("Nothing needs you right now.");
  });
});

describe("the fictional example never looks real (audit item 2)", () => {
  const today = (props: Partial<React.ComponentProps<typeof TodayPage>> = {}) => text(renderToStaticMarkup(React.createElement(TodayPage, {
    brief: null, names: {}, onSunday: () => {}, now: FRI, zone: ET, store: memoryStore(), ...props,
  })));
  const invented = /Tonight's orientation|Ignore your rules|Fictional import|Harbor Example Church|An email told me/u;

  it("shows none of the example's invented items on a Today that isn't the example", () => {
    // Not connected yet, and the example not chosen: what to do next, and nothing invented.
    const notConnected = today({ notConnected: { onConnect: () => {}, onExample: () => {} } });
    expect(notConnected).not.toMatch(invented);
    expect(notConnected).toContain("Not connected yet Planning Center Connect Planning Center to see your Sunday");
    expect(notConnected).toContain("Ozzie hasn't read anything from your church yet, so nothing on this page is about your church. Connecting is a sign-in in your browser, and Ozzie only reads: it changes nothing in Planning Center.");
    expect(notConnected).toContain("Connect Planning Center See the fictional example");
    // Nothing to brief before anything is read; no set-aside on a card asking to connect.
    expect(notConnected).not.toContain("Listen to today's briefing");
    expect(notConnected).not.toContain("Set aside");
    // Connected, a real check on screen: never the example's items either (the default is no example).
    expect(today({ brief: { ...brief, mode: "live" } })).not.toMatch(invented);
    expect(today()).not.toMatch(invented);
  });

  it("asks to connect in place of the unchecked Sunday, and only while the example isn't on", () => {
    expect(todayItems(input({ notConnected: true }))).toEqual([{ id: "connect:planning-center", state: "needs-you", since: null, subject: { type: "connect" } }]);
    expect(todayItems(input({ notConnected: true, sunday: sundayAt(FRI, 1) })).map(i => i.id)).toEqual(["sunday:92902197"]);
    const example = today({ example: true, notConnected: { onConnect: () => {}, onExample: () => {} } });
    expect(example).toMatch(invented);
    expect(example).not.toContain("Connect Planning Center to see your Sunday");
  });

  it("puts the example's band, with its way out, in large type across every page while it's on", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("{!showSetup && fictional && <ExampleBand onLeave={leaveExample} />}");
    expect(app).toContain("example={fictional}");
    // True on every page it sits over, including the ones that show the leader's own rules, lists, settings and cards (review P, L9).
    expect(app).toContain('export const EXAMPLE_BAND = { title: "Example church, not real.", body: "The Sunday, teams, people and email shown are made up. Your own Church rules, lists, settings and visitor cards are real.", leave: "Leave the example" } as const;');
    expect(app).not.toContain("Nothing in it is from your church.");
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.oz \.example-band p \{[^}]*font-size: 17px/u);
  });
});

describe("Today says what is running and what was missed (audit item 24)", () => {
  const regular = (over: Partial<RegularCheck> = {}): RegularCheck => ({
    ready: true, paused: false, running: false, intervalMinutes: 60, runOnLaunch: true,
    last: { at: "2026-11-20T14:06:00.000Z", ok: true }, next: "2026-11-20T15:06:00.000Z", missed: [], ...over,
  });
  it("leads In progress with the regular Sunday check once it can run, with how often, when it last and next looks", () => {
    expect(regularLine(regular(), FRI, ET)).toBe("Checks Planning Center every hour while Ozzie is open, and when it opens. Last checked 9:06 AM. Next check 10:06 AM.");
    expect(regularLine(regular({ runOnLaunch: false, intervalMinutes: 30, last: null }), FRI, ET)).toBe("Checks Planning Center every 30 minutes while Ozzie is open. Not checked yet. Next check 10:06 AM.");
    expect(regularLine(regular({ paused: true }), FRI, ET)).toContain("Paused: nothing runs until you resume it in What runs automatically.");
    expect(regularLine(regular({ running: true }), FRI, ET)).toContain("Checking now.");
    expect(regularLine(regular({ last: { at: "2026-11-19T14:06:00.000Z", ok: false } }), FRI, ET)).toContain("Last checked Thu 9:06 AM, but that check couldn't finish.");
    const keeping = responsibility(KEEP, "keep-sunday-covered");
    const items = todayItems(input({ regular: regular(), watch: view({ items: [keeping] }) }));
    expect(items.filter(i => GROUP_OF[i.state] === "progress").map(i => i.id)).toEqual(["regular:sunday-check", `watching:${KEEP}`]);
    // Not until it can run: then In progress says what starts it.
    expect(todayItems(input({ regular: regular({ ready: false }) })).map(i => i.id)).toEqual(["sunday-unchecked"]);
    expect(progressEmptyText(regular({ ready: false }), false)).toBe("Nothing runs yet. The regular Sunday check starts once Planning Center is connected and a Sunday is chosen; Keep Sunday covered and other jobs start when you set them up.");
    expect(progressEmptyText(null, true)).toBe("Nothing runs in the fictional example.");
  });

  it("says plainly when a check was missed because Ozzie wasn't running, and when it looked again", () => {
    expect(regularMissedText(regular(), FRI, ET)).toBeNull();
    expect(regularMissedText(regular({ missed: ["2026-11-20T12:00:00.000Z"] }), FRI, ET))
      .toBe("A check was due at 7:00 AM, but Ozzie wasn't running or this Mac was asleep. It checked again at 9:06 AM.");
    expect(regularMissedText(regular({ missed: ["2026-11-20T14:30:00.000Z", "2026-11-20T13:30:00.000Z"] }), FRI, ET))
      .toBe("A check was due at 9:30 AM and 1 other time, but Ozzie wasn't running or this Mac was asleep. It checks again when it can.");
  });

  it("shows it on Today, never as nothing under way", () => {
    const page = text(renderToStaticMarkup(React.createElement(TodayPage, {
      brief: null, names: {}, onSunday: () => {}, now: FRI, zone: ET, store: memoryStore(), regular: regular({ missed: ["2026-11-20T12:00:00.000Z"] }),
    })));
    const progress = page.slice(page.indexOf("In progress"));
    expect(progress).toMatch(/^In progress 1 item Always on Planning Center Services The regular Sunday check Checks Planning Center every hour while Ozzie is open, and when it opens\. Last checked 9:06 AM\. Next check 10:06 AM\. A check was due at 7:00 AM, but Ozzie wasn't running or this Mac was asleep\. It checked again at 9:06 AM\./u);
    expect(page).not.toMatch(/under way/u);
    expect(page).not.toMatch(HIDDEN_WORDS);
  });
});

describe("Today names the decisions (audit item 17)", () => {
  const decided = applyDecisions(brief, []);
  it("names each one: role, how many still needed, when, and how many on the team are clear; counts and roles only", () => {
    const { named, more } = decisionLines(decided.items, { rooms: 0, followUps: 0 }, ET);
    expect(more).toBe(0);
    expect(named.map(l => l.text)).toEqual([
      expect.stringMatching(/^Greeter: 1 more person needed, \w{3} \d{1,2}:\d{2} [AP]M\. 1 on the team is clear for that time\.$/u),
      expect.stringMatching(/^Nursery: 1 more person needed, \w{3} \d{1,2}:\d{2} [AP]M\. No one else on the team is clear for that time\.$/u),
    ]);
    expect(named.map(l => l.people)).toEqual([true, false]);
    // Never a person's name, never ranked.
    for (const l of named) {
      for (const name of Object.values(names)) expect(l.text).not.toContain(name);
      expect(l.text).not.toMatch(/\b(?:rank|score|best|top|at risk)\b/iu);
    }
  });

  it("names at most five, then says how many more are on Sunday, rooms and follow-ups counted as they are on the Sunday page", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ state: "open", finding: { key: `k${i}`, kind: "needs-people", tone: "decision", remaining: 2, position: { name: `Role ${i}`, interval: null },
      people: { suggestions: [], conflicts: [] } } }));
    const { named, more } = decisionLines(many, { rooms: 2, followUps: 1 }, ET);
    expect(named).toHaveLength(DECISIONS_NAMED);
    expect(more).toBe(7 - 5 + 2 + 1);
    expect(named[0]!.text).toBe("Role 0: 2 more people needed, this Sunday. No one else on the team is clear for that time.");
    expect(decisionLines([], { rooms: 2, followUps: 1 }, ET).named.map(l => l.text)).toEqual(["2 room booking overlaps to review.", "A follow-up has no owner and is past due."]);
    // Worth a look and what the person resolved are never named here.
    expect(decisionLines([{ state: "open", finding: { key: "l", kind: "streak", tone: "look" } }, { state: "resolved", finding: { key: "r", kind: "needs-people", tone: "decision" } }],
      { rooms: 0, followUps: 0 }, ET).named).toEqual([]);
  });

  it("says a kids team's background check as Planning Center shows it: none current, or one that expires first; never a name (review P, L7)", () => {
    const kid = (check?: string) => ({ state: "open", finding: { key: `bg-${check ?? "x"}`, kind: "background-check", tone: "decision", check,
      position: { name: "Nursery", interval: null } } });
    const lines = decisionLines([kid("none-current"), kid("expires-before-sunday"), kid()], { rooms: 0, followUps: 0 }, ET).named.map(l => l.text);
    expect(lines).toEqual([
      "Nursery: someone scheduled for this Sunday has no current background check on file.",
      "Nursery: a background check on file expires before this Sunday.",
      "Nursery: a background check is missing or expires before this Sunday.",
    ]);
    // Never "a check on file needs a look" when none is on file.
    for (const l of lines) expect(l).not.toContain("needs a look");
  });

  it("shows them on Today's Sunday card, each with a way straight to its card, and Worth a look counted apart", () => {
    const opened: string[] = [];
    const html = renderToStaticMarkup(React.createElement(TodayPage, { brief, names, onSunday: () => {}, now: FRI, zone: ET, store: memoryStore(), onSundayCard: (k: string) => { opened.push(k); } }));
    const card = text(html).slice(text(html).indexOf("Sunday has 2 things to decide."), text(html).indexOf("Ready to review"));
    expect(card).toMatch(/Greeter: 1 more person needed, .+\. 1 on the team is clear for that time\. See who could help Nursery: 1 more person needed, .+\. No one else on the team is clear for that time\. Open on Sunday/u);
    expect(card).toContain("Also 2 things worth a look on Sunday.");
    expect(card).not.toContain("more on Sunday.");
    expect(html).toMatch(/<span id="([^"]+)-d0">Greeter[^<]*<\/span><button type="button" class="btn btn-quiet btn-sm" aria-describedby="\1-d0">See who could help<\/button>/u);
  });

  it("the Sunday page moves to the card Today asked for by its own title element, scrolling only the page pane", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../src/sunday-page.tsx", import.meta.url), "utf8");
    expect(page).toContain('<h3 className="find-title" tabIndex={-1} ref={titleRef}>{title}</h3>');
    expect(page).toContain("titleRef={titleRef(i.finding.key)}");
    // Never by searching the page, and never scrollIntoView (it scrolls the whole window).
    expect(page).not.toMatch(/scrollIntoView\(|getElementById|querySelector|\.closest\(/u);
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("onSundayCard={key => { setSundayFocus(key); setPage(\"sunday\"); }}");
    expect(app).toContain("if (focusProcedure || sundayFocus) return;");
  });
});
