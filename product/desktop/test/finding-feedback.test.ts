// Finding feedback on screen: the controls each card offers, what a person's entries set aside, the
// Church rules list, and Thursday's Sunday Ready brief. Static renders with the fictional Sunday only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SundayPage } from "../src/sunday-page.js";
import { RulesPage } from "../src/rules-page.js";
import { TodayPage } from "../src/today-page.js";
import { SundayReadyBrief, sundayReadyLine } from "../src/sunday-ready.js";
import { correctionChoices, correctionSaid, FindingFeedback, FromYourCards, type FeedbackControls, type FeedbackSource } from "../src/finding-feedback.js";
import { buildSundayBrief, sundayShownCount, type SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { nov22Capture, PEOPLE, TEAMS } from "../../../core/src/fictional-sunday.js";
import { FICTIONAL_ROOM, fictionalOperations, withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { sundayOperations, type SundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, decide } from "../../../core/src/sunday-decisions.js";
import { briefTarget, type CorrectionWhat, type FeedbackEntry } from "../../../core/src/finding-feedback.js";
import { evaluateAttentionImport } from "../../../core/src/attention-import/index.js";
import { harborAttentionImport } from "../../../core/src/fictional-attention.js";

const AT = "2026-11-20T15:10:00Z";
const names = nov22Capture().names;
const base: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const FORBIDDEN = /\b(approve|block|skills?|sessions?|agent|connector|harness|score|rank(ed|ing)?|at risk|drifting|log)\b/i;
function sentRequest(): SundayCapture {
  const capture = nov22Capture();
  const members = capture.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; attributes: Record<string, unknown> }[];
  members.find(m => m.id === "403")!.attributes.notification_sent_at = "2026-11-18T12:00:00Z";
  return capture;
}
const source = (entries: FeedbackEntry[] = []): FeedbackSource => ({ entries, onEntries: () => undefined });
/** Today's set-aside and first-seen times, kept in memory for one render. */
const memory = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); } }; };
const controls = (entries: FeedbackEntry[] = []): FeedbackControls => ({ entries, names, change: () => undefined });
const briefOf = (capture: SundayCapture = nov22Capture(), feedback: FeedbackEntry[] = [], rules: SundayRules = base) =>
  buildSundayBrief(capture, { ...rules, feedback }, capture.completed_at, true);
function page(b: SundayBrief, entries: FeedbackEntry[] = [], operations: SundayOperations | null = null) {
  return renderToStaticMarkup(React.createElement(SundayPage, {
    brief: b, names, busy: false, problem: "", sender: "Pat", connected: false, hasRecording: false, configured: false,
    canReword: false, decisions: [], onDecisions: () => undefined, operations, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    feedback: source(entries),
  }));
}
const card = (b: SundayBrief, kind: string, position?: string) => {
  const f = b.findings.find(x => x.kind === kind && (!position || x.position?.name === position))!;
  return text(renderToStaticMarkup(React.createElement(FindingFeedback, { target: briefTarget(f, b.plan.id, b.plan.dates), feedback: controls() })));
};

describe("the controls on each finding card", () => {
  it("open roles: This isn't right and how to be told, never Stop flagging (they're settled one Sunday at a time)", () => {
    const t = card(briefOf(), "needs-people", "Greeter");
    expect(t).toContain("This isn't right");
    expect(t).toContain("Always tell me right away");
    expect(t).toContain("Put this in the briefing");
    expect(t).not.toContain("Stop flagging this");
  });

  it("a serving streak: Stop flagging this, but no notice choices (it never brings a notice)", () => {
    const t = card(briefOf(), "streak");
    expect(t).toContain("This isn't right");
    expect(t).toContain("Stop flagging this");
    expect(t).not.toContain("Always tell me right away");
    expect(t).not.toContain("Put this in the briefing");
    expect(t).not.toContain("Always do this");
  });

  it("a request sent with no answer: Always do this (a reminder) and the briefing, but never right away (Worth a look)", () => {
    const t = card(briefOf(sentRequest()), "pending");
    expect(t).toContain("Always do this");
    expect(t).toContain("Put this in the briefing");
    expect(t).not.toContain("Always tell me right away");
  });

  it("a check that couldn't be completed offers nothing that could set it aside", () => {
    const failed = nov22Capture();
    failed.reads.find(r => r.collection === "plan_times")!.outcome = "timeout";
    expect(card(briefOf(failed), "worth-a-look").trim()).toBe("");
  });

  it("every control is a labelled button in a named group; a chosen setting is pressed and says what it means", () => {
    const b = briefOf();
    const f = b.findings.find(x => x.kind === "needs-people")!;
    const html = renderToStaticMarkup(React.createElement(FindingFeedback, {
      target: briefTarget(f, b.plan.id, b.plan.dates), feedback: controls([{ type: "urgency", id: "u", kind: "needs-people", at: AT, level: "briefing" }]),
    }));
    expect(html).toContain("role=\"group\" aria-label=\"Tell Ozzie about this\"");
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*Put this in the briefing/u);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Always tell me right away/u);
    expect(html).toContain("aria-expanded=\"false\"");
    expect(text(html)).toContain("Ozzie keeps open roles for your briefing: no notice, even close to Sunday. They still show here.");
  });
});

describe("This isn't right asks what is wrong before hiding anything (audit item 28)", () => {
  const b = briefOf();
  const role = briefTarget(b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!, b.plan.id, b.plan.dates);
  const streak = briefTarget(b.findings.find(f => f.kind === "streak")!, b.plan.id, b.plan.dates);
  const form = (t: typeof role, startWhat: CorrectionWhat | null = null) => renderToStaticMarkup(React.createElement(FindingFeedback, {
    target: t, feedback: controls(), startOpen: "correct", startWhat }));
  it("on an open role: the role isn't open, a person's details, or something else, with nothing chosen and nothing hidden yet", () => {
    const html = form(role);
    const t = text(html);
    expect(t).toContain("What isn't right?");
    expect(t).toContain("The role isn't open Ozzie hides it for this Sunday and keeps your note. It comes back if Planning Center changes.");
    expect(t).toContain("A person's details are wrong Ozzie keeps showing the open role and keeps your note.");
    expect(t).toContain("Something else Ozzie keeps showing it and keeps your note.");
    expect(html).not.toMatch(/type="radio"[^>]*checked/u);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Choose what isn&#x27;t right<\/button>/u);
    expect(t.indexOf("What isn't right?")).toBeLessThan(t.indexOf("What should Ozzie have seen? (optional)"));
  });
  it("names the effect on its button: only the role itself hides it", () => {
    expect(form(role, "finding")).toContain(">Hide it for this Sunday</button>");
    for (const w of ["person", "other"] as const) expect(form(role, w)).toContain(">Keep it showing and save my note</button>");
  });
  it("on other kinds: the finding itself, or something else", () => {
    const t = text(form(streak));
    expect(t).toContain("This finding is wrong Ozzie hides it for this Sunday");
    expect(t).toContain("Something else");
    expect(t).not.toContain("A person's details are wrong");
    expect(correctionChoices("attention", "for this import", "what was imported").map(c => c.label)).toEqual(["This finding is wrong", "Something else"]);
  });
  it("confirms what happened, with where it can be undone later", () => {
    expect(correctionSaid("finding", "for this Sunday")).toBe("Got it. I've hidden this for this Sunday and kept your note. Undo brings it back now; later, it's under “What you've told Ozzie” on Church rules.");
    expect(correctionSaid("person", "for this Sunday")).toBe("Got it. I kept your note, and this still shows. You can delete the note under “What you've told Ozzie” on Church rules.");
  });
  it("a note that keeps the role showing is on the Sunday page and listed on Church rules as still showing", () => {
    const entry: FeedbackEntry = { type: "correction", id: "c", kind: "needs-people", at: AT, key: role.key, occurrence: role.occurrence, facts: role.facts,
      scope: role.scope, labels: { occurrence: "November 22, 2026" }, note: "Drew moved to the 11:00", what: "person" };
    const t = text(page(briefOf(nov22Capture(), [entry]), [entry]));
    expect(t).toContain("Greeter still needs one more person.");
    expect(t).not.toContain("Hidden by you");
    const rules = text(renderToStaticMarkup(React.createElement(FromYourCards, { feedback: controls([entry]) })));
    expect(rules).toContain("You said: “Drew moved to the 11:00” It still shows.");
    expect(t.replaceAll("not ranked", "")).not.toMatch(FORBIDDEN);
  });
});

describe("what the person's entries do on the Sunday page", () => {
  it("a stopped finding is gone, counted and listed as set aside with a way back; nothing else moves", () => {
    const streak = briefOf().findings.find(f => f.kind === "streak")!;
    const entry: FeedbackEntry = { type: "stop", id: "s", kind: "streak", at: AT, scope: { person_id: streak.person_id! }, labels: {} };
    const t = text(page(briefOf(nov22Capture(), [entry]), [entry]));
    expect(t).not.toContain(`${names[streak.person_id!]} is scheduled 3 weeks in a row.`);
    // The leader hid it, so the page says so, not that a rule did (audit item 4).
    expect(t).toContain("You hid one finding: it's under “Hidden by you” at the end of this page, where you can bring it back.");
    expect(t).toContain("Hidden by you");
    expect(t).not.toMatch(/set aside by your Church rules/iu);
    expect(t).toContain(`Don't flag serving streaks for ${names[streak.person_id!]}.`);
    expect(t).toContain("Start flagging this again");
    expect(t).toContain("Greeter still needs one more person.");
    expect(t.replaceAll("not ranked", "")).not.toMatch(FORBIDDEN);
  });

  it("Always do this: the reminder is already prepared when the card opens, and says which rule asked for it", () => {
    const entry: FeedbackEntry = { type: "always", id: "a", kind: "pending", at: AT, action: "prepare-reminder", scope: { team_id: TEAMS.lyrics, position: "Lyrics" }, labels: {} };
    const t = text(page(briefOf(sentRequest(), [entry]), [entry]));
    expect(t).toContain("Draft only. Nothing has been sent.");
    expect(t).toContain(`To ${names[PEOPLE.lyricsPending]}`);
    expect(t).toContain(`Hi ${names[PEOPLE.lyricsPending]!.split(" ")[0]},`);
    expect(t).toContain("Prepared because of your Church rule: “Always prepare a reminder note when a request for Lyrics has no answer yet.”");
    expect(t).toContain("Copy draft");
    // Only Nursery's card (a note to its leader) still offers "Always do this"; the Lyrics card has its rule.
    expect(t.match(/Always do this/gu)).toHaveLength(1);
    // Without the rule, the reminder waits for the person to ask.
    const plain = text(page(briefOf(sentRequest())));
    expect(plain).toContain("Prepare a reminder");
    expect(plain).not.toContain("Draft only. Nothing has been sent.");
    expect(plain.match(/Always do this/gu)).toHaveLength(2);
  });

  it("a room overlap set aside is gone from its card list, listed as set aside, and never leaves a “nothing found” line", () => {
    const rules: SundayRules = { ...base, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 30 }] };
    const capture = withFictionalOperations(nov22Capture());
    const before = sundayOperations(capture, rules)!;
    const room = before.result!.findings.find(f => f.kind === "room-overlap")!;
    expect(text(page(briefOf(capture, [], rules), [], before))).toContain("Stop flagging this");
    const entry: FeedbackEntry = { type: "stop", id: "r", kind: "room-overlap", at: AT, scope: { room_id: room.resource_id }, labels: { room: "Fellowship Hall" } };
    const after = sundayOperations(capture, { ...rules, feedback: [entry] })!;
    const t = text(page(briefOf(capture, [entry], rules), [entry], after));
    expect(t).not.toContain("has overlapping bookings");
    expect(t).not.toContain("No room overlaps in what was read");
    expect(t).toContain("Don't flag overlapping room bookings in Fellowship Hall.");
  });
});

describe("Church rules lists what the person said, and lets them change it", () => {
  const entries: FeedbackEntry[] = [
    { type: "stop", id: "s", kind: "streak", at: AT, scope: { person_id: PEOPLE.greeterConfirmed }, labels: {} },
    { type: "always", id: "a", kind: "pending", at: AT, action: "prepare-reminder", scope: { team_id: TEAMS.lyrics, position: "Lyrics" }, labels: {} },
    { type: "urgency", id: "u", kind: "needs-people", at: AT, level: "right-away" },
    { type: "correction", id: "c", kind: "needs-people", at: AT, key: "k", occurrence: "92902197", facts: "f", scope: { team_id: TEAMS.nursery, position: "Nursery" },
      labels: { occurrence: "November 22, 2026" }, note: "Two helpers already" },
  ];

  it("shows each kind of entry under its own heading with a plainly named way to undo it", () => {
    const t = text(renderToStaticMarkup(React.createElement(RulesPage, { rules: { ...base, feedback: entries }, onChange: () => undefined, positions: [], names })));
    expect(t).toContain("What you've told Ozzie");
    expect(t).toContain(`Don't flag Don't flag serving streaks for ${names[PEOPLE.greeterConfirmed]}.`);
    expect(t).toContain("Start flagging this again");
    expect(t).toContain("Always do Always prepare a reminder note when a request for Lyrics has no answer yet.");
    expect(t).toContain("Stop doing this");
    expect(t).toContain("How Ozzie tells you Always tell me right away about open roles.");
    expect(t).toContain("Quiet hours still hold it unless you let urgent notices through.");
    expect(t).toContain("Go back to the usual");
    expect(t).toContain("Corrections you've made Open roles for Nursery, November 22, 2026");
    expect(t).toContain("You said: “Two helpers already”");
    expect(t).toContain("Delete my correction");
    expect(t).not.toMatch(FORBIDDEN);
  });

  it("each button says which entry it removes, for a screen reader", () => {
    const html = renderToStaticMarkup(React.createElement(FromYourCards, { feedback: controls(entries) }));
    expect(html).toContain(`aria-label="Start flagging this again: Don&#x27;t flag serving streaks for ${names[PEOPLE.greeterConfirmed]}."`);
    expect(html).toContain("aria-label=\"Delete my correction: Open roles for Nursery, November 22, 2026\"");
  });

  it("with nothing yet, says how to add one", () => {
    expect(text(renderToStaticMarkup(React.createElement(FromYourCards, { feedback: controls() })))).toContain("Nothing yet. On a finding, choose “This isn't right”");
  });
});

describe("Today", () => {
  it("This isn't right on the email-and-calendar finding sets it aside for that import", () => {
    const shown = text(renderToStaticMarkup(React.createElement(TodayPage, { brief: null, onSunday: () => undefined, feedback: source(), store: memory(), example: true })));
    expect(shown).toContain("2 things need your attention.");
    expect(shown).toContain("This isn't right");
    // Email and calendar bring no notices, so no notice choices and nothing to stop flagging.
    expect(shown).not.toContain("Always tell me right away");
    expect(shown).not.toContain("Stop flagging this");
    const report = evaluateAttentionImport(harborAttentionImport());
    if (!report.ok) throw new Error("fictional import");
    const f = report.findings[0]!;
    const entry: FeedbackEntry = { type: "correction", id: "c", kind: "attention", at: AT, key: f.id, occurrence: f.imported_at.slice(0, 10),
      facts: JSON.stringify([...f.source_ids].sort()), scope: {}, labels: {}, note: "" };
    const hidden = text(renderToStaticMarkup(React.createElement(TodayPage, { brief: null, onSunday: () => undefined, feedback: source([entry]), store: memory(), example: true })));
    expect(hidden).not.toContain(f.title);
    // Set aside before grouping: only the unchecked Sunday is left to need attention.
    expect(hidden).toContain("1 thing needs your attention.");
    expect(hidden).toContain("Needs your attention 1 item");
  });

  it("Sunday's count on Today leaves out what the person's Church rules set aside", () => {
    const b = briefOf();
    const greeter = briefTarget(b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!, b.plan.id, b.plan.dates);
    const today = (entries: FeedbackEntry[]) => text(renderToStaticMarkup(React.createElement(TodayPage, {
      brief: briefOf(nov22Capture(), entries), onSunday: () => undefined, feedback: source(entries), store: memory(),
    })));
    expect(today([])).toContain("Sunday has 2 things to decide.");
    const entry: FeedbackEntry = { type: "correction", id: "c", kind: "needs-people", at: AT, key: greeter.key, occurrence: greeter.occurrence, facts: greeter.facts,
      scope: greeter.scope, labels: {}, note: "" };
    expect(today([entry])).toContain("Sunday has 1 thing to decide.");
  });

  it("the Ready for Sunday brief says the same counts as Today and the Sunday page, rooms, follow-ups and group meetings included (live review 2026-11-18)", () => {
    const b = briefOf(), ops = fictionalOperations();
    const shown = sundayShownCount(applyDecisions(b, []), ops);
    expect(shown).toMatchObject({ decisions: 4, looks: 2 });
    const today = text(renderToStaticMarkup(React.createElement(TodayPage, { brief: b, operations: ops, onSunday: () => undefined, store: memory() })));
    expect(today).toContain("Sunday has 4 things to decide.");
    const t = text(renderToStaticMarkup(React.createElement(SundayReadyBrief, { brief: b, operations: ops, names, onSunday: () => undefined })));
    expect(t).toContain("4 things need a decision, and 2 are worth a look.");
    expect(t).toContain("Rooms, follow-ups and group meetings");
  });

  it("the Ready for Sunday brief lists everything open, what wasn't checked and when it was read", () => {
    const b = briefOf();
    const decisions = [decide(b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!, "not-needed", "Only two babies", AT)];
    const t = text(renderToStaticMarkup(React.createElement(SundayReadyBrief, { brief: b, decisions, operations: fictionalOperations(), names, onSunday: () => undefined })));
    expect(t).toContain("Ready for Sunday");
    expect(t).toContain("Needs a decision Greeter still needs one more person.");
    expect(t).not.toContain("Nursery still needs");
    expect(t).toContain("You resolved 1 yourself.");
    expect(t).toContain("Worth a look");
    expect(t).toContain("What I didn't check");
    expect(t).toContain("Open Sunday to decide");
    expect(t.replaceAll("not ranked", "")).not.toMatch(FORBIDDEN);
    expect(text(renderToStaticMarkup(React.createElement(SundayReadyBrief, { brief: null, names, onSunday: () => undefined })))).toContain("Sunday hasn't been checked yet");
    // A kind with no line of its own reads its first fact.
    expect(sundayReadyLine({ ...b.findings[0]!, kind: "kids-room" as never, why: ["Planning Center shows one confirmed person in Kids at 9:30."] }, names))
      .toBe("Planning Center shows one confirmed person in Kids at 9:30.");
  });
});
