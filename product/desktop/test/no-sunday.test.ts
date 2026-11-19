// The freeze minimum (onboarding spec §5.1, decision 18): nothing may call a non-Sunday service "Sunday". Every page this
// lane owns, rendered with a fixed Wednesday plan inside the day words, and the notice's day code: none says "Sunday"
// outside the two kinds of example text the spec keeps (a Church rule's "fifth Sundays" example, and Siri's fixed phrases,
// which a person says aloud). The notes a person sends and Ask's answers are rendered too (review H4). The fictional example
// church is a Sunday, and keeps its own words. So does Check-Ins, which counts only Sunday check-ins
// (core/src/church-reads/checkins.ts), and the AI's exact instructions (core/skills), which a line above them explains
// (decision 18, NM3).
import { readdirSync, readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { DayProvider, dayWords, SUNDAY_WORDS, UNKNOWN_WORDS } from "../src/day-words.js";
import { noticeDayOf, noticeLine, procedureNote, procedurePurpose } from "../src/day-phrases.js";
import { TodayPage } from "../src/today-page.js";
import { DecisionForm, Draft, LeaderNote, ReminderNote, SundayPage, WhoCouldHelpCard } from "../src/sunday-page.js";
import { RulesPage } from "../src/rules-page.js";
import { ProactivePage } from "../src/proactive-page.js";
import { ActivityPage } from "../src/activity-page.js";
import { ConnectionPage } from "../src/connection-page.js";
import { AskPanel, HowItWorks } from "../src/ask-panel.js";
import { SiriShortcutsSection, ACTION_NAMES, ACTION_PHRASES, ASK_NAME, OPEN_NAME } from "../src/siri-shortcuts-section.js";
import { createProactive, DEFAULT_PREFS, type KeyValueStore, type ProactiveView } from "../src/proactive.js";
import { sundayProblem, type Settings } from "../src/sunday-source.js";
import { waitingText } from "../src/move-on.js";
import type { RegularCheck } from "../src/today-groups.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { captureToCoverage, type SundayCapture, type SundayRules } from "../../../core/src/sunday-capture.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { decide } from "../../../core/src/sunday-decisions.js";
import { withKidsBackgroundChecks, withKidsTeam } from "../../../core/src/kids-rules.js";
import { TEAMS } from "../../../core/src/fictional-sunday.js";
import { wednesdayCapture, wednesdayWithChecks, wednesdayWithEverything, wednesdayWithOperations, wednesdayWords } from "../../../core/test/fixtures/service-days/wednesday.js";
import { nov22Capture, withFictionalBackgroundChecks } from "../../../core/src/fictional-sunday.js";
import { FICTIONAL_ROOM, withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { canEscalate } from "../../../core/src/escalation-draft.js";
import { canRemind } from "../../../core/src/reminder-draft.js";
import type { Finding } from "../../../core/src/sunday-brief.js";
import { onDayPage } from "../../../core/src/ask.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { composeAnswer, kidsAnswer, kidsQuestion, decisionsLeftOut, openDecisions } from "../../../core/src/harness/compose.js";
import type { ModelStep, ToolEnvelope } from "../../../core/src/harness/contract.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../../core/src/harness/tools.js";
import { askOzzie, buildHarnessData, createAppHarness, lookAtWhoCouldHelp } from "../src/harness-bridge.js";
import { answer, calls, draftTurns, facts, payloadOf, scripted } from "./harness-fakes.js";
import { describeChange, type SundayChange } from "../../../core/src/sunday-changes.js";
import { briefTarget, KIND_WORDS, stopEntry } from "../../../core/src/finding-feedback.js";
import { NOTE_KIND_WORDS, SOURCE_PROBLEMS } from "../../../core/src/sources/words.js";
import { SETUP_APPS } from "../../../core/mcp/setup.js";
import { noticedChanges } from "../src/responsibility-words.js";
import type { NoticedItem } from "../src/responsibility-runner.js";
import { ChurchListsPage } from "../src/church-lists-page.js";
import { createChurchSources, TOO_MANY_POINTERS, TOO_MANY_TICKED, type Invoke } from "../src/church-sources.js";
import { CardsReview, emptyUi, MATCHES_NEED_CHECK, MATCHES_NEED_CHURCH, readingFor } from "../src/cards-page.js";
import { CardReviewController } from "../../src/card-review/controller.js";
import { ADD_OPENED, OtherAiAppsSetup } from "../src/other-ai-apps-setup.js";
import { installFakeDom } from "./fake-dom.js";

const WED = wednesdayWords();
const NOW = "2026-11-20T15:10:00Z";
const ZONE = "America/New_York";
const settings: Settings = { clientId: "", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const rules: SundayRules = { sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }], checkInAfterSundaysInARow: 3 };
const kidsRules: SundayRules = withKidsBackgroundChecks(withKidsTeam(rules, TEAMS.nursery, 2), true);

/** What the spec keeps: a Church rule's own example, and Siri's fixed phrases (onboarding spec §5.2). */
const ALLOWED = ["fifth Sundays", ...ACTION_NAMES, ...ACTION_PHRASES, ASK_NAME, OPEN_NAME, "Is Sunday covered"];
const withoutAllowed = (html: string) => ALLOWED.reduce((s, a) => s.replaceAll(a, ""), html);
/**
 * Sentences Settings shows from files outside this lane that still say Sunday, named so the lane that owns each converts
 * it (reported to the lead). The test asserts each still shows, so this list fails, and must shrink, once one is fixed.
 */
const NOT_YET_CONVERTED: readonly { text: string; file: string }[] = [
  // Check-Ins really does count Sundays (core/src/church-reads/checkins.ts keeps only Sunday check-in times).
  { text: "at last Sunday&#x27;s times", file: "planning-center-more.tsx" },
];
/** Rendered inside the Wednesday day words, as App provides them. */
const onWednesday = (el: React.ReactElement) => renderToStaticMarkup(React.createElement(DayProvider, { value: WED }, el));
/** "Sunday" with a capital S: never a class, id or code name, which are lower case. Attributes (labels, placeholders) count. */
const sundays = (html: string) => withoutAllowed(html).match(/.{0,60}Sunday.{0,60}/gu) ?? [];

const brief = (capture: SundayCapture = wednesdayCapture(), r: SundayRules = rules): SundayBrief => buildSundayBrief(capture, r, NOW);
const regular = (over: Partial<RegularCheck> = {}): RegularCheck => ({
  ready: true, paused: false, running: false, intervalMinutes: 60, runOnLaunch: true, last: { at: "2026-11-20T14:06:00Z", ok: true }, next: "2026-11-20T15:06:00Z",
  missed: ["2026-11-20T12:00:00Z"], ...over,
});
const memoryStore = (): KeyValueStore => { const data = new Map<string, string>(); return { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } }; };
const today = (over: Partial<React.ComponentProps<typeof TodayPage>> = {}) => onWednesday(React.createElement(TodayPage, {
  brief: brief(), names: wednesdayCapture().names, onSunday: () => {}, now: NOW, zone: ZONE, store: memoryStore(), regular: regular(), ...over,
}));
const sundayPage = (b: SundayBrief | null, over: Partial<React.ComponentProps<typeof SundayPage>> = {}) => onWednesday(React.createElement(SundayPage, {
  brief: b, names: wednesdayCapture().names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: true, configured: true, canReword: false,
  decisions: [], onDecisions: () => {}, operations: null, onCheck: () => {}, onRecording: () => {}, onExample: () => {}, ...over,
}));

/** A real controller run on the Wednesday capture: a baseline, then a decline, as Keeping watch shows it. */
async function wednesdayView(): Promise<ProactiveView> {
  let now = "2026-11-20T15:00:00Z", declined = false;
  const p = createProactive({
    store: memoryStore(), now: () => now, timeZone: () => ZONE, notify: async () => {}, problem: sundayProblem,
    timers: { setInterval: () => 0, clearInterval: () => {} },
    check: async () => {
      const c = wednesdayCapture();
      if (declined) {
        const members = c.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; attributes: Record<string, unknown> }[];
        members.find(m => m.id === "401")!.attributes.status = "D";
      }
      return { ...c, completed_at: now, reads: c.reads.map(r => ({ ...r, checked_at: now })) };
    },
  });
  const status = { state: "connected" as const, organization: "1001", checked_at_ms: null, source: "", problem: null };
  p.start({ context: () => ({ settings, rules, status }), onStatus: () => {}, onCapture: () => {} });
  await p.tick();
  declined = true; now = "2026-11-20T16:00:00Z";
  await p.tick();
  p.pause();
  return p.view();
}

describe("the Wednesday fixture", () => {
  it("is a Wednesday, read by the same day words every page gets", () => {
    expect(WED).toMatchObject({ kind: "weekday", day: "Wednesday", question: "Is Wednesday covered?", thisOne: "this Wednesday" });
    expect(brief().day).toEqual(WED);
    expect(JSON.stringify(wednesdayWithOperations())).not.toMatch(/Sunday/u);
  });
});

describe("no page calls a Wednesday service Sunday (onboarding spec §5.1)", () => {
  it("Today: decisions, Ozzie's hourly look, a missed check, and each card's buttons", () => {
    const html = today();
    expect(html).toContain("Wednesday has");
    expect(html).toContain("Ozzie keeps an eye on Wednesday");
    expect(html).toContain("Open Wednesday");
    expect(sundays(html)).toEqual([]);
  });

  it("Today before a check, before a plan, and before Planning Center is connected", () => {
    const unchecked = today({ brief: null, regular: regular({ ready: false, last: null, missed: [] }) });
    expect(unchecked).toContain("Is Wednesday covered?");
    expect(unchecked).toContain("Check Wednesday");
    const waiting = today({ brief: null, waiting: waitingText("Youth Night") });
    expect(waiting).toContain("Ozzie is waiting for the next Youth Night plan in Planning Center.");
    const notConnected = today({ brief: null, regular: null, notConnected: { onConnect: () => {}, onExample: () => {} } });
    expect(notConnected).toContain("Connect Planning Center to see your Wednesday");
    for (const html of [unchecked, waiting, notConnected]) expect(sundays(html)).toEqual([]);
  });

  it("the service page: open roles, a missing lead, kids teams, background checks, rooms and group meetings", () => {
    const capture = wednesdayWithChecks();
    const b = brief(capture, kidsRules);
    expect(b.findings.map(f => f.kind)).toEqual(expect.arrayContaining(["needs-people", "lead-missing", "streak", "background-check"]));
    const ops = sundayOperations(wednesdayWithOperations(), rules, { now: NOW });
    const html = sundayPage(b, { operations: ops, worthALook: React.createElement("p", null, "WORTH-A-LOOK-SLOT") });
    expect(html).toContain("Is Wednesday covered?");
    expect(html).toContain("WORTH-A-LOOK-SLOT");
    expect(sundays(html)).toEqual([]);
  });

  it("the service page with a decision made, a partial read, and nothing checked yet", () => {
    const b = brief();
    const nursery = b.findings.find(f => f.kind === "needs-people" && f.position?.name === "Nursery")!;
    const decided = sundayPage(b, { decisions: [decide(nursery, "not-needed", "Only two babies registered", NOW)] });
    expect(decided).toContain("Resolved by you — this Wednesday only");
    expect(decided).toContain("Nursery isn&#x27;t needed this Wednesday.");
    const partial = wednesdayCapture();
    partial.reads = partial.reads.map(r => r.collection === "person_blockouts" ? { ...r, outcome: "timeout" as const } : r);
    const incomplete = sundayPage(brief(partial));
    expect(incomplete).toContain("Part of this Wednesday couldn&#x27;t be checked");
    const none = sundayPage(null, { connected: false, configured: false, problem: sundayProblem("denied"), refused: true, onSettings: () => {} });
    for (const html of [decided, incomplete, none]) expect(sundays(html)).toEqual([]);
  });

  it("a decision's own form: the buttons say this Wednesday; only the Church-rule example keeps fifth Sundays", () => {
    for (const choice of ["covered-outside", "not-needed", "lead-expected"] as const) {
      const html = onWednesday(React.createElement(DecisionForm, { choice, onSave: () => {}, onCancel: () => {} }));
      expect(sundays(html)).toEqual([]);
    }
    expect(onWednesday(React.createElement(DecisionForm, { choice: "not-needed", onSave: () => {}, onCancel: () => {} }))).toContain("Mark it not needed this Wednesday");
  });

  it("Church rules", () => {
    const capture = wednesdayCapture();
    const html = onWednesday(React.createElement(RulesPage, {
      rules: kidsRules, onChange: () => {}, positions: captureToCoverage(capture, kidsRules, NOW).positions, names: capture.names, rooms: [],
    }));
    expect(html).toContain("How your church wants Wednesday checked");
    expect(html).toContain("Wednesday leads");
    expect(sundays(html)).toEqual([]);
    const empty = onWednesday(React.createElement(RulesPage, { rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 }, onChange: () => {}, positions: [] }));
    expect(sundays(empty)).toEqual([]);
  });

  it("Keeping watch", async () => {
    const view = await wednesdayView();
    const html = onWednesday(React.createElement(ProactivePage, {
      view, names: wednesdayCapture().names, organization: "1001", planId: "92902197", readiness: "ready", busy: false, now: "2026-11-20T16:05:00Z", churchTimeZone: ZONE,
      onCheckNow: () => {}, onPause: () => {}, onResume: () => {}, onPrefs: () => {},
    }));
    expect(html).toContain("Keeping watch");
    expect(sundays(html)).toEqual([]);
  });

  it("What happened", () => {
    const html = onWednesday(React.createElement(ActivityPage, { capture: wednesdayWithOperations() }));
    expect(sundays(html)).toEqual([]);
  });

  it("Settings, with Check my setup and the slot for walking through setup again", () => {
    const html = onWednesday(React.createElement(ConnectionPage, {
      status: null, settings, onSettings: () => {}, onStatus: () => {}, oneClick: true, prefs: DEFAULT_PREFS, onAutomatic: () => {}, onSetup: () => {}, onCheckSetup: () => {},
      autostart: { get: async () => false, set: async () => false }, recordingCount: 2, onDeleteRecordings: () => {}, nameStore: { get: () => "", set: () => {} },
    }));
    expect(html).toContain("Which service Ozzie watches");
    expect(html).toContain("Ozzie keeps an eye on Wednesday");
    expect(html).toContain("Check my setup");
    expect(html).toContain("Walk through setup again");
    for (const known of NOT_YET_CONVERTED) expect(html, known.file).toContain(known.text);
    expect(sundays(NOT_YET_CONVERTED.reduce((h, k) => h.replaceAll(k.text, ""), html))).toEqual([]);
  });

  it("Siri and Shortcuts: only the fixed phrases a person says keep Sunday", () => {
    for (const on of [false, true]) {
      const html = onWednesday(React.createElement(SiriShortcutsSection, { on, onChange: () => {}, problem: null }));
      expect(sundays(html)).toEqual([]);
    }
  });

  it("the Ask panel", () => {
    const html = onWednesday(React.createElement(AskPanel, {
      open: true, onClose: () => {}, ask: () => new Promise<never>(() => {}), brief: brief(), modelReady: true, onOpen: () => {},
    }));
    expect(html).toContain("this Wednesday");
    expect(sundays(html)).toEqual([]);
  });
});

describe("the coverage notice names the real day by a closed code (native contract N8)", () => {
  it("a Wednesday plan asks for the Wednesday line; Sunday only when the plan is on a Sunday", () => {
    expect(noticeDayOf(WED)).toBe("wednesday");
    expect(noticeLine(noticeDayOf(WED))).toBe("Wednesday coverage needs attention. Open Ozzie to see details.");
    expect(noticeDayOf(SUNDAY_WORDS)).toBe("sunday");
    expect(noticeLine("sunday")).toBe("Sunday coverage needs attention. Open Ozzie to see details.");
    const weekend = dayWords({ sort_date: "2026-11-21T17:00:00Z", times: ["2026-11-21T23:00:00Z", "2026-11-22T15:00:00Z"] }, "America/Chicago");
    expect(noticeDayOf(weekend)).toBe("weekend");
    expect(noticeLine("weekend")).toBe("This weekend's coverage needs attention. Open Ozzie to see details.");
    const spread = dayWords({ sort_date: "2026-11-25T19:00:00Z", times: ["2026-11-26T01:00:00Z", "2026-11-29T15:00:00Z"] }, "America/Chicago");
    expect(noticeDayOf(spread)).toBe("service");
    expect(noticeDayOf(UNKNOWN_WORDS)).toBe("service");
    expect(noticeDayOf(null)).toBe("service");
    expect(noticeLine("service")).toBe("Service coverage needs attention. Open Ozzie to see details.");
  });

  it("every day's line is fixed text with no Sunday unless the code is sunday", () => {
    for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "weekend", "service"] as const) {
      expect(noticeLine(day)).not.toMatch(/Sunday|\d|https?/u);
    }
  });
});

// ---- Review H4: the notes a person sends to volunteers and leaders, and Ask's answers ----------------------------------

const skills = await bundledSkills();
/** Rooms, kids teams, background checks and a lead rule, so every kind of answer has something to say. */
const askRules: SundayRules = { ...withKidsTeam(kidsRules, TEAMS.lyrics, 1), rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 15 }] };
const appData = (capture: SundayCapture, r: SundayRules = askRules): HarnessData => {
  const b = buildSundayBrief(capture, r, NOW);
  const nursery = b.findings.find(f => f.kind === "needs-people" && f.position?.team_id === TEAMS.nursery);
  return buildHarnessData({ capture, fictional: false, rules: r, decisions: nursery ? [decide(nursery, "not-needed", "Only two babies registered", NOW)] : [],
    status: null, configured: false, now: NOW });
};
const wednesdayData = (r: SundayRules = askRules) => appData(wednesdayWithEverything(), r);
const harnessOver = (data: HarnessData, model: ModelStep) => createAppHarness({ workspace_id: "w", data, skills, session: new HarnessSession(), loop: "ts", step: model });
/** One Ask turn as the panel shows it: its body (through the panel's onDayPage, as ask-panel.tsx shows it), its draft and its gaps. */
async function asked(data: HarnessData, typed: string, turns: Parameters<typeof scripted>[0] = []) {
  const turn = await askOzzie(harnessOver(data, scripted(turns).model), typed, { skills, sender: "Pat" });
  if (turn.state !== "answered") throw new Error(`${typed}: ${turn.state}`);
  const d = data.brief!.day!;
  return [onDayPage(turn.answer.body, d), turn.answer.draft ?? "", ...turn.answer.gaps.map(g => onDayPage(g, d))].join("\n\n");
}
const overviewTurns = [
  () => calls(["sunday.overview"]),
  (r: Parameters<Parameters<typeof scripted>[0][number]>[0]) => answer(JSON.stringify({ answer: "facts", facts: ((JSON.parse(r.messages.at(-1)!.content) as { payload: { findings: { fact: string; tone: string }[] } })
    .payload.findings).filter(f => f.tone === "needs a decision").map(f => f.fact) })),
];
const untimed = (f: Finding): Finding => ({ ...f, position: { ...f.position!, interval: null } });
/** The fictional capture with the Lyrics request shown as sent, so a reminder can be prepared for it. */
const withSentRequest = (capture: SundayCapture): SundayCapture => {
  const members = capture.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; attributes: Record<string, unknown> }[];
  members.find(m => m.id === "403")!.attributes.notification_sent_at = "2026-11-18T12:00:00Z";
  return capture;
};
/** The three notes the service page prepares (a request, a reminder, a note to the team's leader), each with and without a service time. */
function notes(capture: SundayCapture): string[] {
  const b = brief(withSentRequest(capture), { ...rules, sundayLeads: [] });
  const need = b.findings.find(f => f.kind === "needs-people" && f.people?.suggestions.length)!;
  const pending = b.findings.find(canRemind)!;
  const leader = b.findings.find(canEscalate)!;
  const names = capture.names, close = () => {};
  return [need, untimed(need)].flatMap(f => [
    renderToStaticMarkup(React.createElement(Draft, { finding: f, person: f.people!.suggestions[0]!.person_id, names, sender: "Pat", sunday: b.plan.date, canReword: false, onClose: close })),
    renderToStaticMarkup(React.createElement(Draft, { finding: f, person: f.people!.suggestions[0]!.person_id, names, sender: "Pat", sunday: null, canReword: false, onClose: close })),
  ]).concat([pending, untimed(pending)].map(f => renderToStaticMarkup(React.createElement(ReminderNote, { finding: f, names, sender: "Pat", onClose: close }))))
    .concat([leader, untimed(leader)].map(f => renderToStaticMarkup(React.createElement(LeaderNote, { finding: f, leader: f.leaders![0]!, names, sender: "Pat", sunday: b.plan.date, onClose: close }))));
}

describe("the notes a person sends to volunteers and leaders say the service's real day (review H4)", () => {
  it("a request, a reminder and a note to the team's leader, with a service time, with only the date, and with neither", () => {
    const html = notes(wednesdayCapture());
    expect(html.join(" ")).toContain("on Wednesday, November 25");
    expect(html.join(" ")).toContain("at the next service");
    for (const note of html) expect(sundays(note)).toEqual([]);
  });

  it("the note Ask drafts", async () => {
    const draft = await asked(wednesdayData(), "Draft a note to someone who could cover Greeter", draftTurns);
    expect(draft).toMatch(/We still need someone for Greeter at \d+:30 [AP]M on November 25\./u);
    expect(sundays(draft)).toEqual([]);
  });

  it("a reminder for a role with no service time says the plan's own date when the page knows it", () => {
    const b = brief(withSentRequest(wednesdayCapture()), { ...rules, sundayLeads: [] });
    const pending = untimed(b.findings.find(canRemind)!);
    const html = renderToStaticMarkup(React.createElement(ReminderNote, { finding: pending, names: wednesdayCapture().names, sender: "Pat", sunday: b.plan.date, onClose: () => {} }));
    expect(html).toContain("on Wednesday, November 25");
    expect(sundays(html)).toEqual([]);
  });

  it("the fictional church is a Sunday, and its notes keep saying so", () => {
    expect(notes(nov22Capture()).join(" ")).toContain("on Sunday, November 22");
  });
});

describe("Ask's answers name the service's real day and page (review H4)", () => {
  it("an AI answer, a job's write-up and who could help are composed with the watched service's own day words", async () => {
    // compose.ts's sentences with day words are tested in core (compose.test.ts); here, that the app passes them.
    const { readFileSync } = await import("node:fs");
    const bridge = readFileSync(new URL("../src/harness-bridge.ts", import.meta.url), "utf8");
    expect(bridge.match(/composeAnswer\(outcome\.answer \?\? "", outcome\.evidence, harness\.data\.brief\?\.day \?\? null\)/gu)).toHaveLength(2);
    expect(bridge).toContain("outcome.evidence, h.data.brief?.day ?? null).paragraphs");
    expect(bridge).not.toMatch(/composeAnswer\([^)]*outcome\.evidence\)/u);
  });

  it("every fact every tool gives, as the AI may choose it, with and without the day words", async () => {
    const data = wednesdayData();
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => NOW });
    const signal = new AbortController().signal;
    const evidence: ToolEnvelope[] = [];
    for (const name of ["sunday.overview", "sunday.open_needs", "sunday.pending_requests", "sunday.rule_checkins", "sunday.not_checked", "rooms.conflicts",
      "followups.unowned", "groups.clashes", "rules.current"]) evidence.push(await tools.run(name, {}, signal, "t"));
    const ids = [...new Set(evidence.flatMap(e => [...JSON.stringify(e.payload).matchAll(/"fact":"(f\d+)"/gu)].map(m => m[1]!)))];
    const lines = [data.brief!.day!, null].flatMap(day => ids.flatMap(id => composeAnswer(JSON.stringify({ answer: "facts", facts: [id] }), evidence, day).paragraphs));
    expect(lines.join(" ")).toMatch(/For Wednesday, November 25, \d+ things need a decision/u);
    for (const line of lines) expect(sundays(onDayPage(line, WED))).toEqual([]);
  });

  it("a decision question, with the decisions its answer left out under the page's real name", async () => {
    const body = await asked(wednesdayData(), "What still needs a decision this week?", overviewTurns);
    expect(body).toContain("Also on the Wednesday page, needing a decision:");
    expect(body).toMatch(/background check on file expires before Wednesday\./u);
    expect(sundays(body)).toEqual([]);
  });

  it("answers written on this Mac: kids teams, background checks, what's set aside, and nobody scheduled", async () => {
    const data = wednesdayData();
    const bodies = [
      await asked(data, "Is the nursery ready?"),
      await asked(data, "Any background check problems?"),
      await asked({ ...data, brief: { ...data.brief!, findings: data.brief!.findings.filter(f => f.kind !== "background-check"),
        hidden: data.brief!.findings.filter(f => f.kind === "background-check").map(finding => ({ finding, entry: { type: "correction" } as never })) } }, "Any background check problems?"),
      await asked(wednesdayData({ ...rules, kidsTeams: [{ team_id: "7599999", min_confirmed: 2 }] }), "Any background check problems?"),
    ];
    expect(bodies[2]).toContain("they're on the Wednesday page.");
    expect(bodies[3]).toContain("No one is confirmed or pending on your kids teams this Wednesday, so there were no background checks to look at.");
    // The same answers' parts, straight from what writes them.
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => NOW }), signal = new AbortController().signal;
    const parts = [await kidsAnswer(tools, kidsQuestion("Who could cover the nursery?", data)!, signal), await decisionsLeftOut(tools, '{"answer":"not-covered"}', [], signal),
      await openDecisions(tools, signal)].flatMap(a => a.paragraphs);
    expect(parts).toContain("On the Wednesday page, needing a decision:");
    for (const body of [...bodies, ...parts]) expect(sundays(body)).toEqual([]);
  });

  it("the fictional church is a Sunday, and its answers keep saying so", async () => {
    const body = await asked(appData(withFictionalOperations(withFictionalBackgroundChecks(nov22Capture()))), "What still needs a decision this week?", overviewTurns);
    expect(body).toContain("Also on the Sunday page, needing a decision:");
    expect(body).toMatch(/background check on file expires before Sunday\./u);
  });
});

// ---- NM3: the rest of what still said Sunday for a Wednesday church -----------------------------------------------------

const change = (kind: SundayChange["kind"], over: Partial<SundayChange> = {}): SundayChange =>
  ({ id: kind, kind, effect: "worse", urgency: "attention", position: "Nursery", team_id: TEAMS.nursery, ...over });
/** A lead going missing and coming back, and someone left out: the changes that named the service's day or page. */
const dayChanges = [change("lead-missing"), change("lead-confirmed", { effect: "better", urgency: "none" }), change("suggestion-left-out", { person_id: "501" })];
const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

describe("NM3: what changed, Church rules' own words, lists, cards and other AI apps say the real day or none", () => {
  it("what changed between checks names this Wednesday and the Wednesday page, on Keeping watch, Today and a job's card", async () => {
    const nameOf = (id: string) => wednesdayCapture().names[id];
    expect(dayChanges.map(c => describeChange(c, nameOf, WED))).toEqual([
      "No one is confirmed to lead Nursery this Wednesday now.",
      "Someone is confirmed to lead Nursery this Wednesday now.",
      `${nameOf("501")!} is now left out for Nursery. The Wednesday page shows why.`,
    ]);
    // The fictional church is a Sunday, and keeps its own words.
    expect(describeChange(dayChanges[0]!, nameOf)).toBe("No one is confirmed to lead Nursery this Sunday now.");
    const view = await wednesdayView();
    view.history.unshift({ at: "2026-11-20T16:01:00Z", kind: "changes", changes: dayChanges });
    const html = onWednesday(React.createElement(ProactivePage, {
      view, names: wednesdayCapture().names, organization: "1001", planId: "92902197", readiness: "ready", busy: false, now: "2026-11-20T16:05:00Z", churchTimeZone: ZONE,
      onCheckNow: () => {}, onPause: () => {}, onResume: () => {}, onPrefs: () => {},
    }));
    expect(html).toContain("No one is confirmed to lead Nursery this Wednesday now.");
    expect(html).toContain("The Wednesday page shows why.");
    expect(sundays(html)).toEqual([]);
    // Today and a job's card list the worse ones with the page's own day words.
    const item = { changes: dayChanges } as unknown as NoticedItem;
    const lines = noticedChanges(item, wednesdayCapture().names, WED);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(sundays(line)).toEqual([]);
    expect(source("today-page.tsx")).toContain("noticedChanges(s.noticed, names, words)");
    expect(source("responsibility-views.tsx")).toContain("noticedChanges(item, names, d)");
  });

  it("Church rules' own words for a missing lead, and the kinds a section of notes can go beside", () => {
    const b = brief(wednesdayWithChecks(), kidsRules);
    const lead = b.findings.find(f => f.kind === "lead-missing")!;
    const entry = stopEntry(briefTarget(lead, b.plan.id, b.plan.dates), { team_id: lead.position!.team_id }, NOW);
    const html = onWednesday(React.createElement(RulesPage, {
      rules: { ...kidsRules, feedback: [entry] }, onChange: () => {}, positions: captureToCoverage(wednesdayCapture(), kidsRules, NOW).positions,
      names: wednesdayCapture().names, rooms: [],
    }));
    expect(html).toContain("a missing lead");
    expect(sundays(html)).toEqual([]);
    for (const words of [...Object.values(KIND_WORDS), ...Object.values(NOTE_KIND_WORDS)]) expect(sundays(words)).toEqual([]);
  });

  it("Church lists, with a check on screen, without one, and with a section of notes open to put beside a card", async () => {
    const encode = (s: string) => new TextEncoder().encode(s).buffer;
    const invoke = (async (command: string, args?: Record<string, unknown>) => {
      if (command === "church_sources") return [
        { id: "keys", kind: "file", label: "Key holders", shown: "key-holders.csv", column: "Team", ticked: [], matches: {}, read_at: null },
        { id: "notes1", kind: "notes", label: "Policies", shown: "policies.md", attachments: [], read_at: null },
      ];
      if (command === "church_source_read") return encode(args?.["id"] === "notes1" ? "# Child safety policy\nTwo adults in every room.\n" : "Name,Team,Door\nAvery,Greeter,East door\n");
      throw new Error(`unexpected ${command}`);
    }) as Invoke;
    const sources = createChurchSources({ invoke, now: () => NOW });
    await sources.load();
    const positions = captureToCoverage(wednesdayCapture(), rules, NOW).positions;
    const withCheck = onWednesday(React.createElement(ChurchListsPage, { sources, positions }));
    // This page imports nothing the sending side does (core/test/sources/stays-on-this-mac.test.ts), the day words
    // included, so it names no day at all.
    expect(withCheck).toContain("Ozzie shows its rows beside the cards you match it to.");
    expect(withCheck).toContain("when you open your service&#x27;s page or this page");
    expect(withCheck).toContain("Which columns to show beside a matched card (up to");
    const noCheck = onWednesday(React.createElement(ChurchListsPage, { sources, positions: [] }));
    expect(noCheck).toContain("Run a check first to see the teams and positions to match.");
    sources.focus({ id: "notes1", section: 0 });
    const attach = onWednesday(React.createElement(ChurchListsPage, { sources, positions }));
    expect(attach).toContain(NOTE_KIND_WORDS["lead-missing"]);
    for (const html of [withCheck, noCheck, attach]) expect(sundays(html)).toEqual([]);
    // What the page says when it can't do something.
    for (const line of [TOO_MANY_TICKED, TOO_MANY_POINTERS, SOURCE_PROBLEMS["section-title"]]) expect(sundays(line)).toEqual([]);
  });

  it("visitor cards: a possible match is with the latest check, and why there are none names no day", async () => {
    const controller = new CardReviewController("fictional-test", { foreground: () => true, createURL: () => "blob:fictional", revokeURL() {}, decode: async () => true });
    const ticket = controller.choose(() => {})!;
    expect(await controller.select(ticket, [new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], "fictional.png", { type: "image/png" })])).toBe("ok");
    const people = wednesdayCapture().names;
    const name = people["501"]!;
    expect(controller.edit(ticket, { card: 1, field: "name", text: name, state: readingFor(name, false) })).toBe("ok");
    const cards = (noMatches: string | null) => onWednesday(React.createElement(CardsReview, {
      controller, ticket, ui: emptyUi, people: noMatches ? {} : people, noMatches, lines: {}, onChoose() {}, onCopy() {}, onDiscard() {}, onSource() {}, onRemoved() {},
    }));
    const html = cards(null);
    expect(html).toContain(`has the same name as ${name.replaceAll("'", "&#x27;")} in the latest check.`);
    expect(html).toMatch(/Possible match: .* in the latest check has the same name\./u);
    for (const shown of [html, cards(MATCHES_NEED_CHECK), cards(MATCHES_NEED_CHURCH)]) expect(sundays(shown)).toEqual([]);
  });

  it("other AI apps: the example question names no day, in the app and in each app's steps", () => {
    const html = onWednesday(React.createElement(OtherAiAppsSetup, { on: true, path: "/Applications/Ozzie.app/Contents/MacOS/ozzie-share" }));
    expect(html).toContain("What still needs attention in Ozzie&#x27;s last check?");
    expect(sundays(html)).toEqual([]);
    expect(sundays(ADD_OPENED)).toEqual([]);
    for (const app of SETUP_APPS) for (const step of app.steps) expect(sundays(step), app.id).toEqual([]);
  });

  it("the service page's not-checked list when a read didn't cover the whole day of the service", () => {
    const capture = wednesdayWithOperations();
    const shifted = { starts_at: "2026-11-25T10:00:00Z", ends_at: "2026-11-26T12:00:00Z" };
    for (const r of capture.reads) if (r.collection === "calendar_resource_bookings" || r.collection === "groups_group_events") r.window = shifted;
    const ops = sundayOperations(capture, rules, { now: NOW })!;
    expect(ops.not_checked).toContain("Room bookings: the read didn't cover the whole day of the service.");
    const html = sundayPage(brief(capture), { operations: ops });
    expect(html).toContain("the read didn&#x27;t cover the whole day of the service");
    expect(sundays(html)).toEqual([]);
  });
});

// ---- The AI's exact instructions, where they're shown: titles say the day, bodies stay word for word (decision 18) -------

/** Each skill file's body as written (after its frontmatter), read from disk: what the AI is given, word for word. */
const SKILL_DIR = new URL("../../../core/skills/", import.meta.url);
const skillFiles = readdirSync(SKILL_DIR).filter(f => f.endsWith(".md")).map(f => {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(readFileSync(new URL(f, SKILL_DIR), "utf8"))!;
  return { id: /^id: (.+)$/mu.exec(m[1]!)![1]!, title: /^title: (.+)$/mu.exec(m[1]!)![1]!, body: m[2]!.trim() };
});
const escapedHtml = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#x27;");
const WED_NOTE = "These are the exact words the AI is given. Where they say Sunday, they mean your Wednesday service.";
/** The page without the AI's exact instructions and the line above each: what's left must not say Sunday. */
const withoutInstructions = (html: string) => skillFiles.reduce((s, f) => s.replaceAll(escapedHtml(f.body), ""), html).replaceAll(escapedHtml(WED_NOTE), "");
const noted = (body: string) => `<p class="small">${escapedHtml(WED_NOTE)}</p><div class="procedure-body">${escapedHtml(body)}</div>`;

describe("the AI's exact instructions on screen (decision 18, NM3)", () => {
  it("the line above them names the service's real day, and is there only when the service isn't on a Sunday", () => {
    expect(procedureNote(WED)).toBe(WED_NOTE);
    expect(procedureNote(SUNDAY_WORDS)).toBeNull();
    const weekend = dayWords({ sort_date: "2026-11-21T17:00:00Z", times: ["2026-11-21T23:00:00Z", "2026-11-22T15:00:00Z"] }, "America/Chicago");
    expect(procedureNote(weekend)).toBe("These are the exact words the AI is given. Where they say Sunday, they mean this weekend's services.");
    const spread = dayWords({ sort_date: "2026-11-25T19:00:00Z", times: ["2026-11-26T01:00:00Z", "2026-11-29T15:00:00Z"] }, "America/Chicago");
    expect(procedureNote(spread)).toBe("These are the exact words the AI is given. Where they say Sunday, they mean these services.");
    expect(procedureNote(UNKNOWN_WORDS)).toBe("These are the exact words the AI is given. Where they say Sunday, they mean the service Ozzie watches.");
    // A procedure's purpose (shown above its exact text) reads naturally for every kind of day.
    expect(skillFiles.map(f => procedurePurpose(skills.get(f.id)!.purpose, WED)).join(" ")).not.toMatch(/Sunday/u);
    expect(procedurePurpose("Brings together what still needs a person's attention before this Sunday.", UNKNOWN_WORDS))
      .toBe("Brings together what still needs a person's attention before your service.");
    expect(procedurePurpose("Finds room bookings this Sunday that overlap under your room rules.", spread)).toBe("Finds room bookings at these services that overlap under your room rules.");
    expect(procedurePurpose("Finds room bookings this Sunday that overlap under your room rules.", SUNDAY_WORDS)).toBe("Finds room bookings this Sunday that overlap under your room rules.");
  });

  it("Church rules › What the AI is asked to do: titles and purposes say Wednesday, each body is the skill file's word for word", () => {
    expect(skillFiles.map(f => f.id).sort()).toEqual([...skills.keys()].sort());
    for (const f of skillFiles) expect(skills.get(f.id)!.body, f.id).toBe(f.body);
    const procedures = [...skills.values()];
    const page = (wrap: (el: React.ReactElement) => string) => wrap(React.createElement(RulesPage, {
      rules, onChange: () => {}, positions: captureToCoverage(wednesdayCapture(), rules, NOW).positions, procedures,
    }));
    const html = page(onWednesday);
    expect(html).toContain("<p class=\"bold\">Ready for Wednesday</p>");
    expect(html).not.toContain("<p class=\"bold\">Sunday ready</p>");
    for (const f of skillFiles) expect(html, f.id).toContain(noted(f.body));
    expect(html.split(escapedHtml(WED_NOTE))).toHaveLength(skillFiles.length + 1);
    expect(sundays(withoutInstructions(html))).toEqual([]);
    // A Sunday church sees the titles as written and no line about Sunday.
    const sunday = page(renderToStaticMarkup);
    expect(sunday).toContain("<p class=\"bold\">Sunday ready</p>");
    expect(sunday).not.toContain("Where they say Sunday");
    for (const f of skillFiles) expect(sunday, f.id).toContain(`<div class="procedure-body">${escapedHtml(f.body)}</div>`);
  });

  it("Ask › See how this works: the procedure's title says Wednesday, its body is word for word, with the line above it", async () => {
    const turn = await askOzzie(harnessOver(wednesdayData(), scripted(overviewTurns).model), "What still needs a decision this week?", { skills, sender: "Pat" });
    if (turn.state !== "answered") throw new Error(turn.state);
    const ready = skills.get("sunday-ready")!;
    for (const answered of [turn.answer, { ...turn.answer, procedure: { title: ready.title, body: ready.body } }]) {
      const html = onWednesday(React.createElement(HowItWorks, { answer: answered }));
      const file = skillFiles.find(f => f.title === answered.procedure!.title)!;
      expect(html).toContain(noted(file.body));
      expect(sundays(withoutInstructions(html))).toEqual([]);
    }
    expect(onWednesday(React.createElement(HowItWorks, { answer: { ...turn.answer, procedure: { title: ready.title, body: ready.body } } })))
      .toContain("Ozzie followed this procedure: Ready for Wednesday");
    const sunday = renderToStaticMarkup(React.createElement(HowItWorks, { answer: { ...turn.answer, procedure: { title: ready.title, body: ready.body } } }));
    expect(sunday).toContain("Ozzie followed this procedure: Sunday ready");
    expect(sunday).not.toContain("Where they say Sunday");
  });

  it("who could help › See how this works: the body is word for word, with the line above it only for a Wednesday", async () => {
    type Row = { fact: string };
    const data = wednesdayData();
    const greeter = data.brief!.findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!;
    const m = scripted([
      () => calls(["sunday.open_needs"]),
      r => calls(["sunday.who_could_help", { role: (payloadOf(r, "sunday.open_needs")!["needs"] as { role: string }[])[0]!.role }]),
      r => facts((payloadOf(r, "sunday.who_could_help")!["people"] as Row[]).map(x => x.fact)),
    ]);
    const turn = await lookAtWhoCouldHelp(d => createAppHarness({ workspace_id: "w", data: d, skills, session: new HarnessSession(), loop: "ts", step: m.model }), data, greeter, { skills });
    if (turn.state !== "answered") throw new Error(turn.state);
    const file = skillFiles.find(f => f.id === "who-could-help")!;
    // Mounted on the fake document, so "See how this works" can be pressed; the globals it replaces are put back after.
    const before = { window: (globalThis as Record<string, unknown>)["window"], document: (globalThis as Record<string, unknown>)["document"] };
    const dom = installFakeDom();
    try {
      const { act } = await import("react");
      const { createRoot } = await import("react-dom/client");
      type Node = { nodeType: number; childNodes: Node[]; textContent: string; getAttribute?: (name: string) => string | null };
      const all = (n: Node): Node[] => [n, ...n.childNodes.flatMap(all)];
      const opened = async (wrap: (el: React.ReactElement) => React.ReactElement) => {
        const root = createRoot(dom.root as unknown as Element);
        await act(async () => { root.render(wrap(React.createElement(WhoCouldHelpCard, { turn, finding: greeter, names: data.capture!.names }))); });
        await act(async () => { dom.press(dom.button("See how this works")!); });
        const nodes = all(dom.root as unknown as Node);
        const body = nodes.find(n => n.getAttribute?.("class") === "procedure-body")!.textContent;
        const seen = dom.seen();
        await act(async () => { root.unmount(); });
        return { body, seen };
      };
      const wed = await opened(el => React.createElement(DayProvider, { value: WED }, el));
      expect(wed.body).toBe(file.body);
      expect(wed.seen).toContain(`Ozzie followed this procedure: ${file.title}${WED_NOTE}${file.body}`);
      expect(sundays(wed.seen.replace(file.body, "").replace(WED_NOTE, ""))).toEqual([]);
      const sun = await opened(el => el);
      expect(sun.body).toBe(file.body);
      expect(sun.seen).not.toContain("Where they say Sunday");
    } finally {
      Object.assign(globalThis, before);
    }
  });
});
