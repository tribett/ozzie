// Changes in Planning Center the leader confirms one at a time (planning-center-changes.ts, change-card.tsx; owner
// decisions 2026-11-17, and the independent words-and-flow review): the words for every cause, the button only while
// changes are on, the check is live and the sign-in includes People, the confirmation in full, the kids-team advice that
// one tap can't get past, focus and Escape, what came back with "Take … off again" (and Hide only once that can't work),
// "Checking Planning Center again…" until the new check, the quit question, What happened by role and Sunday, every page
// exactly as before with changes off, and the change code kept away from anything that reaches a model, a notice, Siri,
// the copy for other AI apps or a scheduled job. Fictional data only; the native side is a stand-in that answers as the
// contract says.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
type Answer = (command: string, args: Record<string, unknown> | undefined) => unknown;
const native = vi.hoisted(() => ({ calls: [] as { command: string; args: Record<string, unknown> | undefined }[],
  answer: (() => Promise.reject("unavailable")) as Answer }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string, args?: Record<string, unknown>) => { native.calls.push({ command, args }); return native.answer(command, args); }),
}));
import { installFakeDom } from "./fake-dom.js";
import { HIDDEN_WORDS, text } from "./harness-fakes.js";
import {
  ACTIVITY_LEDE_ON, addButton, BACKGROUND_CHECKS, backgroundFact, CHECKING, changes, CONFIRM_EXPIRED, confirmChecked, confirmPlace, confirmPlaceBack, confirmTitle, confirmUndo,
  confirmUndoEnds, confirmUntil,
  confirmWaiting, despiteChoice, despiteHelp, dontAdd, HISTORY_WHO, historyLine, KIDS_MARKED, KIDS_NOT_ADVISED, kidsAdvice, NO_PEOPLE_YET, notKnown,
  outcomeSentence, PREPARE_FAILED, quitUndo, RECHECK_FAILED, RECHECKING, refusalOf, REFUSALS, refusalSentence, selectFirst, SETTINGS_BANNER_ON, SIDEBAR_ON,
  SWITCH_LABEL, SWITCH_TITLE, switchBody, switchOff, takeOff, UNDO_TOO_MANY, undoNotKnown, undoSentence, yesAdd,
  type BackgroundCheck, type ChangeRecord, type Outcome, type Proposed, type Refusal, type Undone,
} from "../src/planning-center-changes.js";
import { ConnectForm, DISCONNECT, useConnectionControl } from "../src/planning-center-forms.js";
import type { ConnectionStatus } from "../src/connection.js";
import { ChangeCard, ChangeHistory, ChangesSwitch, checkedClock, sundayChanges, useChanges, type ChangeResult, type ChangesControl, type OpenChange } from "../src/change-card.js";
import { mayTryUndoAgain } from "../src/planning-center-changes.js";
import { SundayPage } from "../src/sunday-page.js";
import { ConnectionPage } from "../src/connection-page.js";
import { ActivityPage } from "../src/activity-page.js";
import { FIRST_RUN, FirstScreen, PromisesSheet } from "../src/first-run-screens.js";
import { firstScreenPromises, promise } from "../src/promises.js";
import { CONNECTION_WORDING } from "../src/connection-page.js";
import { QuitQuestion, quitWords, useQuitGuard, type ChecksState } from "../src/quit-question.js";
import { HELP, neverElsewhere } from "../src/harness-words.js";
import { NEVER_TEXT } from "../src/responsibility-words.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture, PEOPLE, TEAMS } from "../../../core/src/fictional-sunday.js";
import { ALL, imports, NATIVE_COMMANDS, names as namesCommand, OFF_THE_PAGE_APIS, reach, source, specifiers } from "../../../core/test/stays-on-this-mac-imports.js";

const dom = installFakeDom();
const capture = nov22Capture();
const names = capture.names;
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const briefAs = (mode: SundayBrief["mode"]): SundayBrief => ({ ...buildSundayBrief(capture, rules, capture.completed_at), mode });
/** The fictional plan in words, as a part of the Services page names it (its service and its day). */
const PLAN_WORDS = "the Sunday Morning plan for Sunday, Nov 22";
const said = { name: "Riley", role: "Greeter", at: "9:30 AM", plan: PLAN_WORDS };
const FORBIDDEN = /\b(approve|block|score|rank(?:ed|ing)?|at risk|drifting|cleared|unsafe|risky)\b/iu;
/** "Nothing is sent to anyone" promises what isn't known (Planning Center's automatic reminders); never said. */
const OVERPROMISE = /nothing is sent to anyone|nothing has been sent to/iu;
const CHECKED = "2026-11-20T15:14:00.000Z";
const proposal = (over: Partial<Proposed> = {}): Proposed => ({
  change: "0123456789abcdef0123456789abcdef", plan: "92902197", team: TEAMS.greeter, person: PEOPLE.riley, position: "Greeter", sunday: "2026-11-22",
  times: [{ starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:30:00Z" }], still_needed: 1, kids_team: false, advised_against: false,
  checked_at: CHECKED, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), ...over,
});
const kidsProposal = (check: BackgroundCheck) => proposal({ kids_team: true, background_check: check, advised_against: check !== "current", team: TEAMS.nursery, position: "Nursery" });
const record = (over: Partial<ChangeRecord> = {}): ChangeRecord => ({
  action: "added-unconfirmed", organization: "1001", service_type: "1500", plan: "92902197", team: TEAMS.greeter, role: "Greeter", sunday: "2026-11-29",
  person: PEOPLE.riley, row: "88001", prepared_at: CHECKED, confirmed_at: "2026-11-20T15:15:00.000Z", sent_at: "2026-11-20T15:15:01.000Z", status: 201,
  came_back: "made", read_back: "as-expected", confirmed_by: "180410771", confirmation: "on-screen", ...over,
});
const pageProps = (brief: SundayBrief) => ({
  brief, names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true, canReword: false,
  decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
});
/** A control as App's hook gives it, for rendering without native code: on, nothing open. */
const control = (over: Partial<ChangesControl> = {}): ChangesControl => ({
  status: { organization: "1001", on: true }, on: true, working: false, problem: null, set: () => undefined, open: null, results: [], rechecks: {}, undoable: [],
  ask: () => undefined, confirm: () => undefined, close: () => undefined, undo: () => undefined, hide: () => undefined,
  history: [], loadHistory: () => undefined, writes: 0, connected: true, ...over,
});
const slot = (c = control(), people = true) => sundayChanges({ control: c, zone: "America/New_York", openPc: async () => true, people, plan: "92902197", service: "Sunday Morning" });
const greeterAsk = { key: "", plan: "92902197", service: "Sunday Morning", team: TEAMS.greeter, role: "Greeter", person: PEOPLE.riley, full: "Riley Thornbury", at: "9:30 AM" };
const AT = checkedClock(CHECKED);

describe("every sentence is true for its cause", () => {
  it("each refusal has its own sentence, and every one says nothing changed", () => {
    const seen = new Set<string>();
    for (const r of REFUSALS) {
      const s = refusalSentence(r, said);
      expect(s, r).toMatch(/^(?:Nothing changed\.|This confirmation waited more than 5 minutes, so Ozzie won't use it\. Nothing changed\.)/u);
      expect(s, r).not.toMatch(FORBIDDEN);
      expect(s, r).not.toMatch(HIDDEN_WORDS);
      seen.add(s);
    }
    expect(seen.size).toBe(REFUSALS.length);
    expect(refusalOf("role-not-open")).toBe("role-not-open");
    expect(refusalOf("something else")).toBeNull();
    expect(refusalOf({ code: "role-not-open" })).toBeNull();
  });

  it("names exactly native code's refusals, in its order", () => {
    const rust = source("core/native-auth/src/change.rs");
    const body = rust.slice(rust.indexOf("pub enum Refusal {"), rust.indexOf("\n}\n", rust.indexOf("pub enum Refusal {")));
    const variants = [...body.matchAll(/^    ([A-Z][A-Za-z]*),$/gmu)].map(m => m[1]!.replace(/(?<!^)(?=[A-Z])/gu, "-").toLowerCase());
    expect(variants).toEqual([...REFUSALS]);
  });

  it("says what each refusal means, and where to go next", () => {
    const s = (r: Refusal) => refusalSentence(r, said);
    expect(s("role-not-open")).toBe("Nothing changed. The Greeter role at 9:30 AM is no longer open in Planning Center.");
    expect(s("blocked-out")).toBe("Nothing changed. Riley has a blockout for that day in Planning Center.");
    expect(s("not-allowed")).toBe("Nothing changed. Planning Center didn't let Ozzie read what it checks before a change, so nothing was sent. You can make this change in Planning Center instead.");
    expect(s("no-people-access")).toBe("Nothing changed. Your sign-in doesn't include Planning Center People, so Ozzie can't confirm Riley isn't listed as a child. You can add People access in Settings, under “Rooms, follow-ups and group events”.");
    expect(s("advice-not-acknowledged")).toBe("Nothing changed. To add Riley despite the advice, select the box that says you still want to.");
    // Native code keeps what it made in memory only: lost on quit, a church switch, Disconnect and turning it off.
    expect(s("not-ozzies-change")).toBe("Nothing changed. Ozzie can take someone off only if it added them since Ozzie was last opened, and before any church switch, disconnect or turning off “Adding people in Planning Center”. You can take Riley off in Planning Center.");
    expect(s("off")).toBe("Nothing changed. Adding people in Planning Center is turned off for this church. You can turn it on in Settings.");
    expect(s("child")).toContain("Planning Center lists Riley as a child");
    // Review S, L9: an inactive person, and a record that doesn't say.
    expect(s("inactive")).toBe("Nothing changed. Planning Center lists Riley as inactive, so Ozzie doesn't add them. You can change that in Planning Center.");
    expect(s("status-unknown")).toBe("Nothing changed. Ozzie couldn't tell from Planning Center's record whether Riley is active, so it doesn't add them. You can check their record in Planning Center.");
    expect(s("split-team")).toContain("scheduled by service time");
    expect(s("repeating-blockout")).toContain("repeating blockout");
    expect(s("other-plan-then")).toContain("on another plan in Planning Center at that time");
    expect(s("check-again")).toContain("Planning Center has changed since the last check");
    expect(s("changed-since-you-looked")).toContain("reads differently now than when Ozzie showed you this change");
    expect(s("expired")).toBe(CONFIRM_EXPIRED);
    expect(s("deadline-passed")).toBe("Nothing changed. Planning Center didn't answer in time, so Ozzie didn't send the change.");
    expect(s("request-already-sent")).toContain("has been sent a request, and Ozzie can't take that back");
    expect(s("person-answered")).toContain("has already answered the request");
  });

  it("what came back from a yes: on the plan (and asked or not only when that was seen), refused, nothing changed, and not known", () => {
    const o = (x: Outcome) => outcomeSentence(x, said);
    // Read back as expected: Planning Center showed the request still waiting.
    expect(o({ result: "made", record: record() })).toBe(
      "Riley is on the Sunday Morning plan for Sunday, Nov 22 as Greeter, unconfirmed. Ozzie sent Riley nothing, and Riley hasn't been asked yet: open the plan in Planning Center and press Send when you're ready.");
    // Not seen: only what is known, and still pointing at Send.
    expect(o({ result: "made", record: record({ read_back: "not-seen" }) })).toBe(
      "Riley is on the Sunday Morning plan for Sunday, Nov 22 as Greeter, unconfirmed. Ozzie sent Riley nothing. Open the plan in Planning Center to check, and press Send when you're ready.");
    const noReadBack: ChangeRecord = { ...record() };
    delete noReadBack.read_back;
    expect(o({ result: "made", record: noReadBack })).not.toContain("hasn't been asked");
    expect(o({ result: "made-after-all", record: record({ came_back: "made-after-all", read_back: "not-seen" }) })).toBe(
      "Planning Center didn't answer clearly, so Ozzie looked again. Riley is on the Sunday Morning plan for Sunday, Nov 22 as Greeter, unconfirmed. Ozzie sent Riley nothing. Open the plan in Planning Center to check, and press Send when you're ready.");
    for (const r of [record(), record({ read_back: "not-seen" })]) expect(o({ result: "made", record: r })).toMatch(/press Send when you're ready\.$/u);
    expect(o({ result: "not-made", reason: "blocked-out" })).toBe(refusalSentence("blocked-out", said));
    expect(o({ result: "refused-by-planning-center", status: 403, not_allowed: true })).toBe("Nothing changed. Planning Center says your account can't schedule people on this team.");
    expect(o({ result: "refused-by-planning-center", status: 422, not_allowed: false })).toBe("Nothing changed. Planning Center didn't accept the change. You can open the plan and make it there.");
    expect(o({ result: "nothing-changed" })).toBe("Planning Center didn't answer clearly. Ozzie looked again: Riley isn't on the plan, so nothing changed.");
    // Not known is never called nothing changed, and says what to look for.
    // Unknown covers both "couldn't look again" and "looked and found them on another row": neither is claimed.
    expect(o({ result: "unknown" })).toBe("Planning Center's answer didn't make clear whether the change was made. Ozzie couldn't tell whether Planning Center added Riley. Open the plan in Planning Center to see whether Riley is on it before trying again. If Riley is there and shouldn't be, take them off there.");
    expect(notKnown("Riley")).toBe("Ozzie couldn't tell whether Planning Center added Riley. Open the plan in Planning Center to see whether Riley is on it before trying again. If Riley is there and shouldn't be, take them off there.");
    for (const s of [o({ result: "unknown" }), notKnown("Riley"), undoNotKnown("Riley")]) expect(s).not.toMatch(/nothing changed/iu);
    expect(PREPARE_FAILED).toMatch(/^Nothing changed\./u);
  });

  it("what came back from Take … off again (only possible while the request is unsent, so it never went)", () => {
    const u = (x: Undone) => undoSentence(x, said);
    expect(u({ result: "removed" })).toBe("Riley is off the Sunday Morning plan for Sunday, Nov 22 again, and the Greeter place is open again. The request was never sent.");
    expect(u({ result: "already-gone" })).toBe("Riley was already off the Sunday Morning plan for Sunday, Nov 22 in Planning Center, so there was nothing to take off.");
    expect(u({ result: "not-removed", reason: "request-already-sent" })).toBe(refusalSentence("request-already-sent", said));
    expect(u({ result: "refused-by-planning-center", status: 403, not_allowed: true })).toBe("Nothing changed. Planning Center says your account can't change people on this team, so Riley wasn't taken off. You can change it in Planning Center.");
    expect(u({ result: "unknown" })).toBe("Ozzie couldn't confirm whether Riley is still on the plan. Open the plan to see.");
    expect(u({ result: "unknown" })).not.toMatch(/nothing changed/iu);
    expect(undoNotKnown("Riley")).toBe("Ozzie couldn't tell whether Planning Center took Riley off. Open the plan in Planning Center to see.");
  });

  it("the background check is Planning Center's record, with when it was read, never a judgment of the person", () => {
    const facts = Object.fromEntries(BACKGROUND_CHECKS.map(c => [c, backgroundFact(c, "Riley", "Sunday, Nov 29", "10:49 AM")]));
    expect(facts).toEqual({
      current: "Planning Center shows a current background check on file for Riley (read at 10:49 AM).",
      "none-on-file": "Planning Center shows no current background check on file for Riley (read at 10:49 AM).",
      pending: "Planning Center shows a background check for Riley that isn't finished yet (read at 10:49 AM).",
      // `expired` means cleared but not marked current: that may not be expiry.
      expired: "Planning Center shows Riley's background check on file is no longer current (read at 10:49 AM).",
      "expires-by-that-sunday": "Planning Center shows Riley's background check on file ends on or before Sunday, Nov 29 (read at 10:49 AM).",
      "could-not-read": "Ozzie couldn't read Riley's background check in Planning Center just now, so it can't tell whether there is a current one.",
    });
    for (const f of Object.values(facts)) expect(f).not.toMatch(FORBIDDEN);
    expect(KIDS_NOT_ADVISED).toBe("Not advised: this is a kids team.");
    expect(KIDS_MARKED).toBe("This team is marked as a kids team in your Church rules.");
    expect(kidsAdvice("none-on-file")).toBe("Ozzie advises adding someone to a kids team only when Planning Center shows a current background check.");
    expect(kidsAdvice("could-not-read")).toBe("Look in Planning Center first. Ozzie advises adding someone to a kids team only when you've seen a current background check.");
    expect(despiteChoice("Riley")).toBe("I've read this advice, and I still want to add Riley to this kids team.");
    expect(despiteHelp("Riley")).toBe("Ozzie won't stop you; this is your choice. If you go ahead, What happened notes that you added Riley despite this advice.");
    expect(selectFirst("Riley")).toBe("Select the box above to add Riley anyway.");
  });

  it("the confirmation's own words: Ozzie sends nothing, the place fills before anyone is asked, how long undo lasts", () => {
    // Polish 2026-11-21 (item 4): one short sentence each in view; what ends the undo, the place given back and the five
    // minutes under the card's fold.
    expect(confirmWaiting("Riley")).toBe("Planning Center will list Riley as unconfirmed, with the request not sent. Ozzie sends Riley nothing; you press Send there.");
    expect(confirmPlace("Riley", "Greeter", 1)).toBe("Adding Riley fills the one open place for Greeter, even before Riley is asked.");
    expect(confirmPlace("Riley", "Greeter", 3)).toBe("Adding Riley fills one of the 3 open places for Greeter, even before Riley is asked.");
    expect(confirmPlaceBack("Riley")).toBe("Taking Riley off again gives the place back.");
    expect(confirmUndo("Riley")).toBe("Until you send the request, you can take Riley off again here while Ozzie stays open.");
    expect(confirmUndoEnds("Riley")).toBe("You can't take Riley off here after you quit Ozzie, switch churches, disconnect or turn off “Adding people in Planning Center” in Settings; then take Riley off in Planning Center.");
    expect(confirmUntil("10:57 AM", "Riley")).toBe("If you wait past 10:57 AM, Ozzie will need to look at Planning Center again before adding Riley.");
  });

  it("What happened says the role and the Sunday, who confirmed as You, what came back, and the advice the leader went past", () => {
    expect(historyLine(record(), "Riley Thornbury")).toBe(
      "You added Riley Thornbury to Greeter on Sunday, Nov 29 as unconfirmed, with the request waiting. Planning Center accepted it, and Ozzie saw it on the plan afterwards.");
    expect(historyLine(record({ read_back: "not-seen" }), "Riley Thornbury")).toBe(
      "You added Riley Thornbury to Greeter on Sunday, Nov 29 as unconfirmed, with the request waiting. Planning Center accepted it; Ozzie couldn't confirm it on the plan afterwards.");
    expect(historyLine(record({ despite_advice: "none-on-file", team: TEAMS.nursery, role: "Nursery" }), "Riley Thornbury")).toBe(
      "You added Riley Thornbury to Nursery on Sunday, Nov 29 as unconfirmed, with the request waiting. Ozzie had advised against it: Planning Center showed no current background check on file for Riley. You chose to go ahead. Planning Center accepted it, and Ozzie saw it on the plan afterwards.");
    expect(historyLine(record({ despite_advice: "expired" }), "a person")).toContain("Ozzie had advised against it: Planning Center showed their background check on file was no longer current. You chose to go ahead.");
    expect(historyLine(record({ came_back: "unknown", read_back: "not-seen" }), "a person")).toContain("You added a person to Greeter on Sunday, Nov 29");
    expect(historyLine(record({ came_back: "unknown" }), "a person")).toContain("Planning Center's answer didn't make clear whether it was made.");
    expect(historyLine(record({ action: "took-off", came_back: "removed" }), "Riley Thornbury")).toBe("You took Riley Thornbury off Greeter on Sunday, Nov 29. Planning Center removed it.");
    for (const r of [record(), record({ came_back: "refused" }), record({ action: "took-off", came_back: "already-gone" })]) {
      expect(historyLine(r, "Riley Thornbury")).not.toMatch(/180410771/u);
    }
    expect(HISTORY_WHO).toBe("Each change was confirmed on this Mac and sent under the Planning Center account signed in here. For someone added, Planning Center shows that account as the scheduler.");
  });

  it("buttons name the person and the effect; no screen promises that nothing reaches anyone", () => {
    expect(addButton("Riley", "Greeter")).toBe("Add Riley to Greeter in Planning Center…");
    expect(yesAdd("Riley", false)).toBe("Add Riley — I'll send the request in Planning Center");
    expect(yesAdd("Riley", true)).toBe("Add Riley anyway — I'll send the request in Planning Center");
    expect(dontAdd("Riley")).toBe("Don't add Riley");
    expect(takeOff("Riley")).toBe("Take Riley off again");
    const words = [yesAdd("Riley", false), dontAdd("Riley"), takeOff("Riley"), SWITCH_LABEL, SWITCH_TITLE, SIDEBAR_ON, ACTIVITY_LEDE_ON, SETTINGS_BANNER_ON.strong,
      SETTINGS_BANNER_ON.rest, ...Object.values(switchBody("First Church")), confirmWaiting("Riley"), outcomeSentence({ result: "made", record: record() }, said)];
    for (const s of words) {
      expect(s).not.toMatch(HIDDEN_WORDS);
      expect(s).not.toMatch(FORBIDDEN);
      expect(s).not.toMatch(OVERPROMISE);
    }
    expect(source("product/desktop/src/planning-center-changes.ts")).not.toMatch(OVERPROMISE);
    expect(source("product/desktop/src/change-card.tsx")).not.toMatch(OVERPROMISE);
  });

  it("Settings says what it adds, the reminders caveat word for word, who Planning Center shows, kids teams, which church, and People access", () => {
    expect(SWITCH_TITLE).toBe("Adding people in Planning Center");
    expect(SWITCH_LABEL).toBe("Let Ozzie add someone to an open role in Planning Center, one at a time, when you confirm each one");
    const b = switchBody("First Church");
    expect(b.reminders).toBe("Ozzie hasn't confirmed whether Planning Center's automatic reminders, if your church uses them, reach someone added this way before the request is sent.");
    // Polish 2026-11-21 (item 3): the one long "what" paragraph and the long "confirm" paragraph are now one sentence each
    // (lead, confirm, waiting, one, never, undo), every promise kept word for word where it was a sentence of its own.
    expect(b.lead).toBe("With this on, you can add someone from an open role's “who could help” list on the Services page to that role, on that service's plan in Planning Center.");
    expect(b.waiting).toBe("Planning Center lists them as unconfirmed, with the request waiting. Ozzie sends them nothing. Planning Center sends its request only when you press Send there.");
    expect(b.one).toBe("One person at a time, and never anyone with a possible conflict, or anyone left out.");
    expect(b.confirm).toBe("Each one needs your confirmation on screen first. Planning Center shows you as the person who scheduled them.");
    expect(b.never).toBe("Ozzie never adds or picks anyone on its own, on a schedule, or from an AI's answer.");
    expect(b.undo).toBe("Until you send the request, you can take the person off again from the Services page while Ozzie stays open; quitting Ozzie, switching churches, disconnecting or turning this off ends that.");
    expect(b.kids).toBe("For a team your church marked as a kids team, Ozzie first shows the person's background check as Planning Center records it, and advises against adding anyone without a current one.");
    expect(b.church).toBe("This is for First Church only; another church has its own switch. It's off until you turn it on, and it turns off if you switch churches or disconnect. To turn it off, untick the box.");
    expect(b.people).toBe("Ozzie also needs People access, to see whether Planning Center lists a person as a child or as inactive and, for kids teams, their background check. Turn it on under “Rooms, follow-ups and group events” below.");
    expect(SIDEBAR_ON).toBe("Reads Planning Center; changes it only when you confirm. Names Ozzie reads stay on this Mac.");
  });

  it("lines shown whether or not changes are on are true either way: Ask's help, a job's promise, and Settings' read-only areas", () => {
    expect(HELP.never).toBe("Ozzie never sends messages, never changes Planning Center unless you confirm that one change, and never writes prayers, sermons or scripture. People decide and people go.");
    // A job only reads, whatever the switch says: form A is exact for it.
    expect(NEVER_TEXT).toBe("It only reads. It never changes anything in Planning Center. It won't contact anyone; you decide what happens next.");
    // A church on another system hears its own never-line: Ozzie only reads there (ask-panel.tsx helpFor).
    expect(neverElsewhere("Breeze")).toBe("Ozzie never sends messages, never changes anything in Breeze, and never writes prayers, sermons or scripture. People decide and people go.");
    expect(source("product/desktop/src/connection-page.tsx")).toContain("Ozzie only reads Calendar, People and Groups, and has no way to change anything in them.");
  });
});

describe("Settings: the switch reads at a glance, and nothing that must be seen is folded away (polish 2026-11-21, item 3)", () => {
  const html = (people: boolean, c = control()) => renderToStaticMarkup(React.createElement(ChangesSwitch, { control: c, church: "First Church", people }));
  const parts = (h: string) => { const at = h.indexOf("<details"); expect(at, "the fold").toBeGreaterThan(-1); return { shown: text(h.slice(0, at)), folded: text(h.slice(at)), fold: h.slice(at) }; };
  it("a one-sentence lead, the switch, then each fact a leader needs before turning it on, all in view", () => {
    const b = switchBody("First Church");
    const { shown } = parts(html(true));
    const order = [b.lead, SWITCH_LABEL, b.confirm, b.waiting, b.one, b.never, `${b.kids} ${b.kidsWhere}`, b.reminders].map(s => shown.indexOf(s));
    expect(order.every(i => i >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // While it's off, that nothing changes is said first.
    expect(text(html(true, control({ on: false, status: { organization: "1001", on: false } })))).toMatch(/^ ?Adding people in Planning Center Adding people is off for First Church, so Ozzie only reads its Planning Center\. With this on/u);
  });
  it("how undo ends, which church it's for and People access are in the app's own closed fold, with the chevron", () => {
    const b = switchBody("First Church");
    const { shown, folded, fold } = parts(html(true));
    expect(fold).toMatch(/^<details class="listen-more changes-more"><summary><svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"><\/path><\/svg>See how this works<\/summary>/u);
    for (const line of [b.undo, b.church, b.people]) { expect(folded).toContain(line); expect(shown).not.toContain(line); }
    // Without People access no one can be added: that stays in view, said once, and the fold doesn't repeat it.
    const without = parts(html(false));
    expect(without.shown).toContain(`${b.people} ${NO_PEOPLE_YET}`);
    expect(without.folded).not.toContain(b.people);
    // Every sentence Settings said before is still said.
    const all = text(html(true));
    for (const sentence of ["Ozzie sends them nothing.", "Planning Center sends its request only when you press Send there.", "Each one needs your confirmation on screen first.",
      "Ozzie never adds or picks anyone on its own, on a schedule, or from an AI's answer.", "Planning Center shows you as the person who scheduled them.",
      "unconfirmed, with the request waiting", "never anyone with a possible conflict, or anyone left out", b.kids, b.kidsWhere, b.reminders, b.church, b.people,
      "Until you send the request, you can take the person off again from the Services page while Ozzie stays open; quitting Ozzie, switching churches, disconnecting or turning this off ends that."]) {
      expect(all, sentence).toContain(sentence);
    }
  });
});

describe("the button is offered only while changes are on, the check on screen is live and the sign-in includes People", () => {
  const rows = (html: string) => [...text(html).matchAll(/Add (\w+) to (\w+) in Planning Center…/gu)].map(m => `${m[1]}:${m[2]}`);
  it("on a live check: on the rows with no overlap found and worth a look, never a possible conflict or anyone left out", () => {
    const html = renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs("live")), changes: slot() }));
    expect(rows(html).sort()).toEqual(["Drew:Greeter", "Riley:Greeter"]);
    expect(text(html)).not.toContain("Add Casey");
  });
  it("without People access no one is offered (native code would refuse each one), and Settings says so once", () => {
    expect(rows(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs("live")), changes: slot(control(), false) })))).toEqual([]);
    const without = text(renderToStaticMarkup(React.createElement(ChangesSwitch, { control: control(), church: "First Church", people: false })));
    expect(without).toContain(`${switchBody(null).people} ${NO_PEOPLE_YET}`);
    expect(without.split(NO_PEOPLE_YET).length - 1).toBe(1);
    expect(text(renderToStaticMarkup(React.createElement(ChangesSwitch, { control: control(), church: "First Church", people: true })))).not.toContain(NO_PEOPLE_YET);
  });
  it("never for the example or a saved check, and never without App's slot", () => {
    for (const mode of ["fictional", "recording"] as const) {
      expect(rows(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs(mode)), changes: slot() }))), mode).toEqual([]);
    }
    expect(rows(renderToStaticMarkup(React.createElement(SundayPage, pageProps(briefAs("live")))))).toEqual([]);
  });
  it("the people keep their grouping and order: the button adds nothing before or between them", () => {
    const order = (html: string) => [...text(html).matchAll(/(Riley Thornbury|Casey Pemberly|Drew Halvorsen)/gu)].map(m => m[1]);
    const before = order(renderToStaticMarkup(React.createElement(SundayPage, pageProps(briefAs("live")))));
    const after = order(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs("live")), changes: slot() })));
    expect(after).toEqual(before);
  });
  it("after a change, that role's card says it is checking again in place of its people (and of every Add button), or that the check didn't come", () => {
    const greeterKey = briefAs("live").findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!.key;
    const waiting = text(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs("live")), changes: slot(control({ rechecks: { "92902197": { plan: "92902197", key: greeterKey, failed: false, since: null } } })) })));
    expect(waiting).toContain(RECHECKING);
    expect(waiting).not.toContain("Riley Thornbury");
    expect(waiting).not.toContain("Add Riley");
    const failed = text(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs("live")), changes: slot(control({ rechecks: { "92902197": { plan: "92902197", key: greeterKey, failed: true, since: null } } })) })));
    expect(failed).toContain(RECHECK_FAILED);
    expect(failed).not.toContain("Add Riley");
  });
});

describe("the confirmation states the change in full", () => {
  const card = (open: OpenChange, c = control({ open })) => text(renderToStaticMarkup(React.createElement(ChangeCard, { open, control: c, zone: "America/New_York" })));
  it("who, which role, which Sunday and time, unconfirmed with the request waiting, what Ozzie sends, the open place, what was checked, and undo", () => {
    const p = proposal();
    const t = card({ ask: greeterAsk, stage: "proposed", proposed: p, sentence: null });
    expect(t).toContain(confirmTitle("Riley Thornbury", "Sunday Morning", "Sunday, Nov 22"));
    // The service by its own name and its day (several services watched), its time, and how many are still needed.
    expect(t).toContain("Greeter · Sunday Morning · Sunday, Nov 22 · 9:30 AM · 1 still needed");
    expect(t).toContain(confirmWaiting("Riley"));
    expect(t).toContain(confirmPlace("Riley", "Greeter", 1));
    expect(t).toContain(confirmChecked(AT, "Riley"));
    expect(t).toContain(confirmUndo("Riley"));
    expect(t).toContain(confirmUntil(checkedClock(p.expires_at), "Riley"));
    expect(t).toContain(yesAdd("Riley", false));
    expect(t).toContain(dontAdd("Riley"));
    expect(t).not.toMatch(/\bApprove\b/u);
    expect(t).not.toContain("background check");
    expect(t).not.toMatch(OVERPROMISE);
    // The undo promise is body text, not small print. Polish 2026-11-21 (item 4): the title, the role's line, what
    // Planning Center does and Ozzie doesn't, the open place, what was checked, the undo and the buttons are in view; the
    // place given back, what ends the undo and the five minutes are in the app's closed fold, before the buttons.
    const html = renderToStaticMarkup(React.createElement(ChangeCard, { open: { ask: greeterAsk, stage: "proposed", proposed: p, sentence: null }, control: control(), zone: "America/New_York" }));
    expect(html).toContain(`<p>${confirmUndo("Riley")}</p>`);
    const at = html.indexOf("<details"), end = html.indexOf("</details>");
    expect(html.slice(at)).toMatch(/^<details class="listen-more change-more"><summary><svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"><\/path><\/svg>See how this works<\/summary>/u);
    const shown = text(html.slice(0, at) + html.slice(end)), folded = text(html.slice(at, end));
    for (const line of [confirmTitle("Riley Thornbury", "Sunday Morning", "Sunday, Nov 22"), "Greeter · Sunday Morning · Sunday, Nov 22 · 9:30 AM · 1 still needed", confirmWaiting("Riley"),
      confirmPlace("Riley", "Greeter", 1), confirmChecked(AT, "Riley"), confirmUndo("Riley"), yesAdd("Riley", false), dontAdd("Riley")]) expect(shown, line).toContain(line);
    for (const line of [confirmPlaceBack("Riley"), confirmUndoEnds("Riley"), confirmUntil(checkedClock(p.expires_at), "Riley")]) {
      expect(folded, line).toContain(line);
      expect(shown, line).not.toContain(line);
    }
    expect(html.indexOf(">Add Riley — I")).toBeGreaterThan(end);
    // No open place to fill: nothing said about one, in view or folded.
    expect(card({ ask: greeterAsk, stage: "proposed", proposed: proposal({ still_needed: 0 }), sentence: null })).not.toContain("place");
  });
  it("says so when it has waited more than five minutes, and offers a fresh look instead of the yes", () => {
    const t = card({ ask: greeterAsk, stage: "proposed", proposed: proposal({ expires_at: new Date(Date.now() - 1000).toISOString() }), sentence: null });
    expect(t).toContain(CONFIRM_EXPIRED);
    expect(t).not.toContain(yesAdd("Riley", false));
    expect(t).toContain("Look again before adding Riley");
  });
  it("checking, and a refusal, in calm words", () => {
    expect(card({ ask: greeterAsk, stage: "checking", proposed: null, sentence: null })).toContain("Checking Planning Center…");
    expect(card({ ask: greeterAsk, stage: "refused", proposed: null, sentence: refusalSentence("role-not-open", said) }))
      .toContain("Nothing changed. The Greeter role at 9:30 AM is no longer open in Planning Center.");
  });
  it("a kids team: Not advised, the church's own mark, the fact with its read time, the advice, then the title; Don't add as the main choice", () => {
    for (const check of BACKGROUND_CHECKS.filter(c => c !== "current")) {
      const html = renderToStaticMarkup(React.createElement(ChangeCard, { open: { ask: { ...greeterAsk, role: "Nursery" }, stage: "proposed", proposed: kidsProposal(check), sentence: null },
        control: control(), zone: "America/New_York" }));
      const t = text(html);
      const order = [KIDS_NOT_ADVISED, KIDS_MARKED, backgroundFact(check, "Riley", "Sunday, Nov 22", AT), kidsAdvice(check), confirmTitle("Riley Thornbury", "Sunday Morning", "Sunday, Nov 22")].map(s => t.indexOf(s));
      expect(order.every(i => i >= 0), check).toBe(true);
      expect([...order].sort((a, b) => a - b), check).toEqual(order);
      expect(t).toContain(despiteChoice("Riley"));
      expect(t).toContain(despiteHelp("Riley"));
      // Don't add is the main (primary) button and comes first; the yes is disabled, its reason beside it.
      expect(html).toMatch(/<button type="button" class="btn btn-primary">Don(?:&#x27;|')t add Riley<\/button><button type="button" class="btn btn-secondary" disabled="" aria-describedby="[^"]+-why">Add Riley anyway — I(?:&#x27;|')ll send the request in Planning Center<\/button><span id="[^"]+-why" class="small change-why">Select the box above to add Riley anyway\.<\/span>/u);
    }
    const current = text(renderToStaticMarkup(React.createElement(ChangeCard, { open: { ask: greeterAsk, stage: "proposed", proposed: kidsProposal("current"), sentence: null },
      control: control(), zone: "America/New_York" })));
    expect(current).toContain(backgroundFact("current", "Riley", "Sunday, Nov 22", AT));
    expect(current).not.toContain(KIDS_NOT_ADVISED);
    expect(current).not.toContain("despite this advice");
    expect(current).toContain(yesAdd("Riley", false));
  });
});

describe("what came back: Hide only once Take … off again can't work", () => {
  const result = (over: Partial<ChangeResult>): ChangeResult => ({ id: 1, ask: greeterAsk, plan: "92902197", day: "2026-11-22", sentence: "Riley is on the Sunday Morning plan for Sunday, Nov 22 as Greeter, unconfirmed.",
    tone: "made", row: "88001", undo: "can", addedAt: null, answer: null, offAt: null, ...over });
  const shown = (r: ChangeResult) => text(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs("live")), changes: slot(control({ results: [r] })) })));
  it("while undo can work: Take Riley off again and Open the plan, no Hide", () => {
    const t = shown(result({}));
    expect(t).toContain(takeOff("Riley"));
    expect(t).toContain("Open the plan in Planning Center");
    expect(t).not.toContain("Hide this");
    expect(shown(result({ undo: "working" }))).not.toContain("Hide this");
  });
  it("once undo is done or was never possible: Hide this", () => {
    for (const undo of ["done", "none"] as const) {
      const t = shown(result({ undo, ...(undo === "done" ? { answer: { result: "removed" as const }, offAt: "2026-11-20T19:04:00.000Z" } : {}) }));
      expect(t, undo).toContain("Hide this");
      expect(t, undo).not.toContain(takeOff("Riley"));
    }
  });
});

// ---- The whole flow, mounted, with native code answering as the contract says --------------------------------------

type El = { tagName: string; childNodes: El[]; getAttribute(n: string): string | null; hasAttribute(n: string): boolean; textContent: string };
const all = (n: El): El[] => [n, ...n.childNodes.flatMap(all)];
const props = (el: El) => (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[Object.keys(el).find(k => k.startsWith("__reactProps$"))!]!;
// React gives an input its type as a property, not an attribute.
const checkbox = () => all(dom.root as unknown as El).find(n => n.tagName === "INPUT" && ((n as unknown as { type?: string }).type ?? n.getAttribute("type")) === "checkbox") ?? null;
const byClass = (cls: string) => all(dom.root as unknown as El).find(n => n.getAttribute?.("class")?.split(" ").includes(cls)) ?? null;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
// Where focus went: every element's focus() is noted.
const focusedOn: { el: El | null } = { el: null };
(Object.getPrototypeOf(dom.root) as { focus(): void }).focus = function (this: El) { focusedOn.el = this; };

/** The control the mounted page last drew with (for what the quit question would say). */
const lastControl: { c: ChangesControl | null } = { c: null };
/** The rest of what the mounted App would pass: which church, and whether What happened is on screen (its list drawn under). */
interface More { organization?: string; showingHistory?: boolean; disconnectTries?: number }
function Mounted({ afterWrite, kids, checkedAt, connected = true, disconnected = false, more = {} }: {
  afterWrite: (plan: string) => Promise<boolean>; kids: readonly string[]; checkedAt: string; connected?: boolean; disconnected?: boolean; more?: More;
}) {
  // The check on screen of the one service watched here, by its plan.
  const c = useChanges({ organization: more.organization ?? "1001", connected, disconnected, kidsTeamIds: kids, afterWrite, checked: { [capture.plan_id]: checkedAt },
    showingHistory: more.showingHistory ?? false, disconnectTries: more.disconnectTries ?? 0 });
  lastControl.c = c;
  return React.createElement(React.Fragment, null,
    React.createElement(SundayPage, { ...pageProps(briefAs("live")),
      changes: c.on ? sundayChanges({ control: c, zone: "America/New_York", openPc: async () => true, people: true, plan: capture.plan_id, service: "Sunday Morning" }) : null }),
    more.showingHistory && c.on ? React.createElement(ChangeHistory, { records: c.history, names }) : null);
}
async function mount(answer: Answer, kids: readonly string[] = [], afterWrite: (plan: string) => Promise<boolean> = () => Promise.resolve(true)) {
  native.calls.length = 0;
  native.answer = answer;
  const wrote = vi.fn(afterWrite);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  // Each mount in a box of its own inside the fake page, taken away when it's unmounted.
  const box = dom.root.appendChild((document as unknown as { createElement(t: string): typeof dom.root }).createElement("div"));
  const created = createRoot(box as unknown as Element);
  const render = (checkedAt: string, connected = true, disconnected = false, more: More = {}) =>
    created.render(React.createElement(Mounted, { afterWrite: wrote, kids, checkedAt, connected, disconnected, more }));
  const root = { render, unmount: () => { created.unmount(); dom.root.removeChild(box); } };
  await act(async () => { render("check-1"); });
  await act(flush);
  return { act, root, afterWrite: wrote, press: async (label: string) => {
    const b = dom.button(label);
    expect(b, label).not.toBeNull();
    await act(async () => { dom.press(b!); });
    await act(flush);
  } };
}
const answers = (table: Record<string, (args: Record<string, unknown> | undefined) => unknown>) => (command: string, args: Record<string, unknown> | undefined) =>
  Object.hasOwn(table, command) ? Promise.resolve().then(() => table[command]!(args)) : Promise.reject("unavailable");
const on = { changes_status: () => ({ organization: "1001", on: true }) };

describe("the flow, one change at a time", () => {
  beforeEach(() => { native.calls.length = 0; focusedOn.el = null; });

  it("with the switch off nothing is offered, and nothing but the switch is asked", async () => {
    const m = await mount(answers({ changes_status: () => ({ organization: "1001", on: false }) }));
    expect(dom.seen()).not.toContain("in Planning Center…");
    expect(native.calls.map(c => c.command)).toEqual(["changes_status"]);
    await m.act(async () => { m.root.unmount(); });
  });

  it("asks, shows the confirmation (focus on its title), sends only the yes, says what happened, waits for the new check, and takes them off again", async () => {
    let arrive!: (ok: boolean) => void;
    const m = await mount(answers({ ...on,
      change_prepare: () => proposal(),
      change_confirm: () => ({ result: "made", record: record() }),
      change_undo: () => ({ result: "removed" }),
    }), [TEAMS.nursery], () => new Promise<boolean>(r => { arrive = r; }));
    await m.press(addButton("Riley", "Greeter"));
    // The plan of the check on screen goes with it, so native code refuses a change for any other plan (security review L1).
    expect(native.calls.find(c => c.command === "change_prepare")?.args).toEqual({ plan: capture.plan_id, team: TEAMS.greeter, position: "Greeter", person: PEOPLE.riley, kidsTeamIds: [TEAMS.nursery] });
    expect(dom.seen()).toContain(confirmTitle("Riley Thornbury", "Sunday Morning", "Sunday, Nov 22"));
    expect(focusedOn.el?.tagName).toBe("H4");
    expect(focusedOn.el?.textContent).toBe(confirmTitle("Riley Thornbury", "Sunday Morning", "Sunday, Nov 22"));
    expect(native.calls.some(c => c.command === "change_confirm")).toBe(false);
    await m.press(yesAdd("Riley", false));
    // The yes is sent once, for that change, with no advice to acknowledge.
    expect(native.calls.filter(c => c.command === "change_confirm").map(c => c.args)).toEqual([{ change: proposal().change }]);
    expect(dom.seen()).toContain(outcomeSentence({ result: "made", record: record() }, said));
    expect(focusedOn.el?.textContent).toBe(outcomeSentence({ result: "made", record: record() }, said));
    expect(dom.button("Open the plan in Planning Center")).not.toBeNull();
    expect(dom.button("Hide this")).toBeNull();
    // Native code dropped the check the change came from: a fresh one is taken, and until it comes Greeter's people wait.
    expect(m.afterWrite).toHaveBeenCalledTimes(1);
    expect(dom.seen()).toContain(RECHECKING);
    expect(dom.button(addButton("Riley", "Greeter"))).toBeNull();
    expect(dom.button(addButton("Drew", "Greeter"))).toBeNull();
    // The new check arrives: the people are back.
    await m.act(async () => { arrive(true); m.root.render("check-2"); });
    await m.act(flush);
    expect(dom.seen()).not.toContain(RECHECKING);
    expect(dom.button(addButton("Drew", "Greeter"))).not.toBeNull();
    await m.press(takeOff("Riley"));
    expect(native.calls.filter(c => c.command === "change_undo").map(c => c.args)).toEqual([{ row: "88001" }]);
    // Once taken off, the card says only what is true now: one sentence, the add's time from its record (10:15 AM here).
    expect(dom.seen()).toMatch(/You added Riley to Greeter at 10:15 AM and took Riley off again at \d{1,2}:\d\d [AP]M\. The Greeter place is open again; the request was never sent\./u);
    expect(dom.seen()).not.toContain("Riley is on the Sunday Morning plan");
    expect(dom.button(takeOff("Riley"))).toBeNull();
    expect(dom.button("Hide this")).not.toBeNull();
    expect(m.afterWrite).toHaveBeenCalledTimes(2);
    await m.act(async () => { arrive(true); m.root.render("check-3"); });
    await m.act(async () => { m.root.unmount(); });
  });

  it("when the new check doesn't come, the role says so plainly and offers no Add button", async () => {
    const m = await mount(answers({ ...on, change_prepare: () => proposal(), change_confirm: () => ({ result: "made", record: record() }) }), [], () => Promise.resolve(false));
    await m.press(addButton("Riley", "Greeter"));
    await m.press(yesAdd("Riley", false));
    expect(dom.seen()).toContain(RECHECK_FAILED);
    expect(dom.button(addButton("Drew", "Greeter"))).toBeNull();
    await m.act(async () => { m.root.render("check-2"); });
    expect(dom.seen()).not.toContain(RECHECK_FAILED);
    await m.act(async () => { m.root.unmount(); });
  });

  it("a kids team without a current check: focus on the advice; one tap can't add them; only the ticked box sends the advice it acknowledges", async () => {
    const m = await mount(answers({ ...on,
      change_prepare: () => kidsProposal("none-on-file"),
      change_confirm: () => ({ result: "made", record: record({ despite_advice: "none-on-file" }) }),
    }), [TEAMS.greeter]);
    await m.press(addButton("Riley", "Greeter"));
    expect(focusedOn.el?.getAttribute("class")).toContain("change-advice");
    expect(focusedOn.el?.textContent).toContain(KIDS_NOT_ADVISED);
    const seen = dom.seen();
    expect(seen.indexOf(KIDS_NOT_ADVISED)).toBeLessThan(seen.indexOf(confirmTitle("Riley Thornbury", "Sunday Morning", "Sunday, Nov 22")));
    expect(seen).toContain(selectFirst("Riley"));
    const yes = dom.button(yesAdd("Riley", true))!;
    expect(yes.hasAttribute("disabled")).toBe(true);
    // Even pressed (a disabled button can't be), nothing is sent.
    await m.press(yesAdd("Riley", true));
    expect(native.calls.some(c => c.command === "change_confirm")).toBe(false);
    const box = checkbox()!;
    expect(box).not.toBeNull();
    await m.act(async () => { props(box).onChange!({ target: { checked: true }, currentTarget: { checked: true } }); });
    expect(dom.button(yesAdd("Riley", true))!.hasAttribute("disabled")).toBe(false);
    expect(dom.seen()).not.toContain(selectFirst("Riley"));
    await m.press(yesAdd("Riley", true));
    expect(native.calls.filter(c => c.command === "change_confirm").map(c => c.args)).toEqual([{ change: proposal().change, despiteAdvice: "none-on-file" }]);
    await m.act(async () => { m.root.unmount(); });
  });

  it("one change at a time: while one is being looked at or sent, every other Add on the page waits (disabled)", async () => {
    let answerPrepare: ((p: Proposed) => void) | null = null;
    let answerConfirm: ((o: Outcome) => void) | null = null;
    const m = await mount(answers({ ...on,
      change_prepare: () => new Promise<Proposed>(done => { answerPrepare = done; }),
      change_confirm: () => new Promise<Outcome>(done => { answerConfirm = done; }),
    }), [], () => new Promise<boolean>(() => {}));
    await m.press(addButton("Riley", "Greeter"));
    // Checking Planning Center for Riley: Drew's Add can't start a second change meanwhile.
    expect(dom.seen()).toContain(CHECKING);
    expect(dom.button(addButton("Drew", "Greeter"))!.hasAttribute("disabled")).toBe(true);
    await m.act(async () => { answerPrepare!(proposal()); });
    await m.act(flush);
    // The confirmation is open: Drew's Add may replace it (one change ready at a time, natively too), not run beside it.
    expect(dom.button(addButton("Drew", "Greeter"))!.hasAttribute("disabled")).toBe(false);
    await m.press(yesAdd("Riley", false));
    // Adding Riley: nothing else can be asked until that answer is in.
    expect(dom.seen()).toContain("Adding Riley in Planning Center…");
    expect(dom.button(addButton("Drew", "Greeter"))!.hasAttribute("disabled")).toBe(true);
    expect(native.calls.filter(c => c.command === "change_prepare")).toHaveLength(1);
    await m.act(async () => { answerConfirm!({ result: "not-made", reason: "busy-with-a-check" }); });
    await m.act(flush);
    await m.act(async () => { m.root.unmount(); });
  });

  it("Escape on the card means Don't add: nothing is sent, and focus goes back to the button that opened it", async () => {
    const m = await mount(answers({ ...on, change_prepare: () => proposal() }));
    await m.press(addButton("Riley", "Greeter"));
    const card = byClass("change-card")!;
    expect(card).not.toBeNull();
    await m.act(async () => { props(card).onKeyDown!({ key: "Escape", stopPropagation() {} }); });
    await m.act(flush);
    expect(byClass("change-card")).toBeNull();
    expect(focusedOn.el?.textContent).toBe(addButton("Riley", "Greeter"));
    expect(native.calls.some(c => c.command === "change_confirm")).toBe(false);
    await m.act(async () => { m.root.unmount(); });
  });

  it("a refusal says why, with focus on Close, and sends nothing more; a refused yes takes no fresh check, since nothing was sent", async () => {
    const m = await mount(answers({ ...on, change_prepare: () => Promise.reject("role-not-open") }));
    await m.press(addButton("Riley", "Greeter"));
    expect(dom.seen()).toContain("Nothing changed. The Greeter role at 9:30 AM is no longer open in Planning Center.");
    expect(focusedOn.el?.tagName).toBe("BUTTON");
    expect(focusedOn.el?.textContent).toBe("Close");
    expect(native.calls.some(c => c.command === "change_confirm")).toBe(false);
    await m.act(async () => { m.root.unmount(); });

    const n = await mount(answers({ ...on, change_prepare: () => proposal(), change_confirm: () => ({ result: "not-made", reason: "blocked-out" }) }));
    await n.press(addButton("Riley", "Greeter"));
    await n.press(yesAdd("Riley", false));
    expect(dom.seen()).toContain("Nothing changed. Riley has a blockout for that day in Planning Center.");
    expect(n.afterWrite).not.toHaveBeenCalled();
    await n.act(async () => { n.root.unmount(); });
  });

  it("an answer that isn't known is said as not known, offers Hide (no undo), and still takes a fresh check", async () => {
    const m = await mount(answers({ ...on, change_prepare: () => proposal(), change_confirm: () => ({ result: "unknown" }) }));
    await m.press(addButton("Riley", "Greeter"));
    await m.press(yesAdd("Riley", false));
    expect(dom.seen()).toContain(outcomeSentence({ result: "unknown" }, said));
    expect(dom.seen()).not.toContain(takeOff("Riley"));
    expect(dom.button("Hide this")).not.toBeNull();
    expect(m.afterWrite).toHaveBeenCalledTimes(1);
    await m.act(async () => { m.root.unmount(); });
  });
});

describe("the quit question, while someone added can still be taken off here", () => {
  it("adds the line, names each person plainly, and says checks stop only when they are really on", () => {
    expect(quitUndo(["Riley"])).toBe("After you quit, Ozzie can't take Riley off again; you can in Planning Center.");
    expect(quitUndo(["Riley", "Sam"])).toBe("After you quit, Ozzie can't take Riley and Sam off again; you can in Planning Center.");
    expect(quitUndo(["Riley", "Sam", "Drew"])).toBe("After you quit, Ozzie can't take Riley, Sam and Drew off again; you can in Planning Center.");
    const off = text(renderToStaticMarkup(React.createElement(QuitQuestion, { ask: { cards: 0, checks: false }, undo: quitUndo(["Riley"]), onQuit() {}, onKeep() {} })));
    expect(off).toContain(quitUndo(["Riley"]));
    expect(off).not.toContain("Checks and notices stop");
    expect(off).toContain("Quit Ozzie?");
    const withChecks = quitWords({ cards: 0, checks: true }, quitUndo(["Riley"]));
    expect(withChecks.lines).toEqual(["Checks and notices stop until you open Ozzie again.", quitUndo(["Riley"]), "Closing the window instead keeps Ozzie running, as the small Ozzie picture at the top of your screen."]);
    // Without it the question is as before.
    expect(quitWords({ cards: 2, checks: false })).toEqual(quitWords({ cards: 2, checks: false }, null));
  });
  it("tells native code to ask (checks: true) when someone can be taken off, while App shows checks only from its own state", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const state: ChecksState = { readiness: "not-connected", schedule: { paused: true }, watch: { paused_all: true, items: [] } };
    const Guard = ({ undoable }: { undoable: boolean }) => { useQuitGuard(0, state, undoable); return null; };
    native.calls.length = 0;
    native.answer = () => Promise.resolve(null);
    const box = dom.root.appendChild((document as unknown as { createElement(t: string): typeof dom.root }).createElement("div"));
    const root = createRoot(box as unknown as Element);
    await act(async () => { root.render(React.createElement(Guard, { undoable: false })); });
    await act(async () => { root.render(React.createElement(Guard, { undoable: true })); });
    expect(native.calls.filter(c => c.command === "quit_guard_set").map(c => c.args)).toEqual([{ cards: 0, checks: false }, { cards: 0, checks: true }]);
    await act(async () => { root.unmount(); });
    dom.root.removeChild(box);
    const app = source("product/desktop/src/App.tsx");
    expect(app).toContain("useQuitGuard(openCards, { readiness, schedule: automatic.schedule, watch }, changes.undoable.length > 0);");
    expect(app).toContain("ask={{ ...quitAsk, checks: checksNow }} undo={changes.undoable.length ? quitUndo(changes.undoable) : null}");
  });
});

describe("with changes off, every page is the same as without the feature's slot", () => {
  it("the Sunday page: off (no slot) is the page without the feature, for a live check, a saved one and the example", () => {
    for (const mode of ["live", "recording", "fictional"] as const) {
      const absent = renderToStaticMarkup(React.createElement(SundayPage, pageProps(briefAs(mode))));
      expect(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs(mode)), changes: null })), mode).toBe(absent);
      expect(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs(mode)), changes: undefined })), mode).toBe(absent);
    }
    // A slot handed over for a saved check or the example is ignored.
    for (const mode of ["recording", "fictional"] as const) {
      expect(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs(mode)), changes: slot() })), mode)
        .toBe(renderToStaticMarkup(React.createElement(SundayPage, pageProps(briefAs(mode)))));
    }
  });

  const settings = { clientId: "", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
  const connection = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(ConnectionPage, {
    status: null, settings, onSettings: () => undefined, onStatus: () => undefined, oneClick: true, nameStore: { get: () => "", set: () => undefined },
    phone: null, ...extra,
  }));
  it("Settings: not connected, nothing is added; connected with changes off, only the switch is, and the line about reading is as before", () => {
    expect(connection({ changes: undefined })).toBe(connection());
    const offControl = control({ on: false, status: { organization: "1001", on: false } });
    const sw = renderToStaticMarkup(React.createElement(ChangesSwitch, { control: offControl, church: "Example Church", people: true }));
    const off = connection({ changes: { section: React.createElement(ChangesSwitch, { control: offControl, church: "Example Church", people: true }), banner: null } });
    expect(off.replace(sw, "")).toBe(connection());
    // True with the switch off right under it (security review L7): the build's form B, a condition, true either way.
    expect(text(off)).toContain(`${promise("readsShort")} ${CONNECTION_WORDING} ${promise("still")}`);
    expect(promise("readsShort")).toBe("Changes only what you confirm.");
    // While it's off the switch says so first (onboarding spec §0.2, form B builds).
    expect(text(sw)).toContain(switchOff("Example Church"));
    expect(text(sw)).toContain(SWITCH_LABEL);
    expect(sw).not.toContain("checked=\"\"");
    // On: the line says what's true then.
    const onPage = text(connection({ changes: { section: null, banner: SETTINGS_BANNER_ON } }));
    expect(onPage).toContain(SETTINGS_BANNER_ON.strong);
    expect(onPage).not.toContain("Ozzie has no way to change records");
  });
  it("What happened: off is the page without the feature; on, the changes come first, by role and Sunday", () => {
    const base = { capture, tasks: [], now: new Date("2026-11-20T16:00:00Z") };
    const absent = renderToStaticMarkup(React.createElement(ActivityPage, base));
    expect(renderToStaticMarkup(React.createElement(ActivityPage, { ...base, changes: undefined }))).toBe(absent);
    // The build's form B (promises.ts), true with the switch off as well as on.
    expect(text(absent)).toContain(`${promise("reads")} ${promise("sends")}`);
    const onPage = text(renderToStaticMarkup(React.createElement(ActivityPage, { ...base, changes: { lede: ACTIVITY_LEDE_ON,
      section: React.createElement(ChangeHistory, { records: [record({ despite_advice: "none-on-file", role: "Nursery", team: TEAMS.nursery })], names }) } })));
    expect(onPage).toContain(ACTIVITY_LEDE_ON);
    expect(onPage).toContain(HISTORY_WHO);
    expect(onPage).toContain("You added Riley Thornbury to Nursery on Sunday, Nov 29 as unconfirmed, with the request waiting. Ozzie had advised against it:");
    expect(onPage).not.toContain("It has no way to change records");
    // A person the check on screen doesn't name is "a person", the role and Sunday still said.
    expect(text(renderToStaticMarkup(React.createElement(ChangeHistory, { records: [record()], names: {} })))).toContain("You added a person to Greeter on Sunday, Nov 29");
  });
  it("first run, before any church exists: the build's form B promises, and every read a change makes listed first", () => {
    // The first screen and the promises sheet follow the build (onboarding spec §0.2): form B, true with the switch off.
    const first = text(renderToStaticMarkup(React.createElement(FirstScreen, { onConnect: () => undefined, onExample: () => undefined, onPromises: () => undefined })));
    for (const line of firstScreenPromises()) expect(first).toContain(line);
    expect(first).not.toMatch(/only reads|never changes anything|Reads only/u);
    const sheet = text(renderToStaticMarkup(React.createElement(PromisesSheet, { onClose: () => undefined })));
    expect(sheet).toContain("If you turn on adding people, adding someone to a kids team also reads that person's check status and end date.");
    // Everything Ozzie can read, before any of it happens: an add's reads, each said only for when adding people is on.
    const reads = FIRST_RUN.reads.join(" ");
    expect(reads).toContain("If you turn on adding people in Settings, adding someone to a team marked as a kids team first reads that person's background check status and end date (cleared and unfinished checks), even when that rule is off.");
    expect(reads).toContain("Only if you turn on adding people in Settings, and only when you add someone: the plan, its open roles and the people on it again, that person's blockouts and other services then, and whether Planning Center lists them as a child and as active, read just before the change.");
  });
  it("the sidebar, Settings and What happened say their on form only while connected with the switch on, for Planning Center only (App.tsx)", () => {
    const app = source("product/desktop/src/App.tsx");
    expect(app).toContain("{changesShownOn ? SIDEBAR_ON\n            : `${promise(\"readsShort\", offPc ? \"A\" : BUILD_FORM)} The names Ozzie reads stay on this Mac.`}");
    expect(app).toContain("const changesShownOn = connected && changesOn;");
    // Never for a church on B1 Church, Breeze or Genesis: the hook has no church, and nothing is handed to a page.
    expect(app).toContain("const changes = useChanges({ organization: offPc ? \"\" : org, connected: connected && !offPc,");
    expect(app).toContain("const changesOn = !offPc && changes.on;");
    // App hands the pages anything about changes only while the switch is on (the switch itself: while connected).
    expect(app).toContain("const mainLive = Boolean(liveBrief && capture?.kind === \"live\" && capture.organization === org && !offPc);");
    expect(app).toContain("const changesOnSunday = mainLive && liveBrief ? changeSlot(liveBrief.plan.id, liveBrief.time_zone, mainName) : null;");
    expect(app).toContain("? { lede: changesShownOn ? ACTIVITY_LEDE_ON : null, section: <ChangeHistory");
    expect(app).toContain("changes={connected && !offPc ? { section: <ChangesSwitch");
    expect(app).toContain("banner: changesShownOn ? SETTINGS_BANNER_ON : null");
  });
});

describe("the security review's page items", () => {
  it("M1: taking off has its own minute limit, said as taking off, and keeps Take … off again offered", () => {
    const u: Undone = { result: "not-removed", reason: "too-many-just-now" };
    expect(undoSentence(u, said)).toBe(UNDO_TOO_MANY);
    expect(UNDO_TOO_MANY).toBe("Nothing changed. That's as many people as Ozzie takes off in one minute. Wait a minute, then try again.");
    expect(UNDO_TOO_MANY).not.toMatch(/\badd/iu);
    expect(mayTryUndoAgain(u)).toBe(true);
    // Adding keeps its own sentence.
    expect(refusalSentence("too-many-just-now", said)).toBe("Nothing changed. That's as many changes as Ozzie makes in one minute. Wait a minute, then try again.");
  });

  it("M3: an expired check says the date it ended when Planning Center records one, and is no longer current without one", () => {
    expect(backgroundFact("expired", "Riley", "Sunday, Nov 29", "10:49 AM", "2026-10-01")).toBe("Planning Center shows Riley's background check on file ended on Thursday, Oct 1 (read at 10:49 AM).");
    expect(backgroundFact("expired", "Riley", "Sunday, Nov 29", "10:49 AM")).toBe("Planning Center shows Riley's background check on file is no longer current (read at 10:49 AM).");
    expect(backgroundFact("expires-by-that-sunday", "Riley", "Sunday, Nov 29", "10:49 AM", "2026-11-28")).toBe(
      "Planning Center shows Riley's background check on file has an end date of Saturday, Nov 28, on or before Sunday, Nov 29 (read at 10:49 AM).");
    const t = text(renderToStaticMarkup(React.createElement(ChangeCard, { open: { ask: greeterAsk, stage: "proposed",
      proposed: { ...kidsProposal("expired"), background_check_date: "2026-10-01" }, sentence: null }, control: control(), zone: "America/New_York" })));
    expect(t).toContain(`Planning Center shows Riley's background check on file ended on Thursday, Oct 1 (read at ${AT}).`);
    // What happened keeps only the fact, never the date, and stays true without it.
    expect(historyLine(record({ despite_advice: "expired" }), "Riley Thornbury")).toContain("Planning Center showed Riley's background check on file was no longer current.");
  });

  it("L3: several rows after no clear answer is said as that (not as couldn't look again), a write that went out, worth a look, no undo", async () => {
    const o: Outcome = { result: "several-rows" };
    expect(outcomeSentence(o, said)).toBe("Planning Center didn't answer clearly, and Ozzie now sees Riley on the plan more than once. Open the plan in Planning Center to check.");
    expect(outcomeSentence(o, said)).not.toMatch(/couldn't look again|nothing changed/iu);
    expect(historyLine(record({ came_back: "several-rows" }), "Riley Thornbury")).toContain("Ozzie looked again and found Riley on the plan more than once.");
    const m = await mount(answers({ ...on, change_prepare: () => proposal(), change_confirm: () => ({ result: "several-rows" }) }));
    await m.press(addButton("Riley", "Greeter"));
    await m.press(yesAdd("Riley", false));
    expect(dom.seen()).toContain(outcomeSentence(o, said));
    expect(dom.seen()).toContain("Worth a look");
    expect(dom.button(takeOff("Riley"))).toBeNull();
    expect(m.afterWrite).toHaveBeenCalledTimes(1);
    await m.act(async () => { m.root.unmount(); });
  });

  it("L4: Settings says the kids advice covers only teams marked in Church rules, and where they are marked", () => {
    expect(switchBody(null).kidsWhere).toBe("That advice covers only teams marked as kids teams in Church rules, under “Kids teams” (each team's “serves with kids” box). A team that isn't marked there gets no background-check advice.");
    expect(source("product/desktop/src/kids-rules-section.tsx")).toContain(">Kids teams</h2>");
    expect(source("product/desktop/src/kids-rules-section.tsx")).toContain("serves with kids</span>");
    expect(text(renderToStaticMarkup(React.createElement(ChangesSwitch, { control: control(), church: null, people: true })))).toContain(switchBody(null).kidsWhere);
  });

  it("L10: a take-off record without who confirmed it still says You", () => {
    const off: ChangeRecord = { ...record({ action: "took-off", came_back: "removed" }) };
    delete off.confirmed_by;
    expect(historyLine(off, "Riley Thornbury")).toBe("You took Riley Thornbury off Greeter on Sunday, Nov 29. Planning Center removed it.");
  });

  it("H1, L7: every line saying Ozzie only reads or changes nothing is true whether adding people is on or off", () => {
    const src = (f: string) => source(`product/desktop/src/${f}`);
    // Each Planning Center line says the build's form B (promises.ts), a condition true with the switch off as well as on.
    expect(src("connection-page.tsx")).toContain("<span><strong>{promise(\"readsShort\")}</strong> {CONNECTION_WORDING} {promise(\"still\")} The connection is kept safely on this Mac.</span>");
    expect(src("activity-page.tsx")).toContain(": promise(\"reads\")} {system ? promise(\"sends\", \"A\") : promise(\"sends\")}");
    expect(src("sunday-source.ts")).toContain("return `Connect Planning Center first. ${promise(\"connectAnd\")}`;");
    expect(src("today-page.tsx")).toContain("Connecting is a sign-in in your browser, and ${promise(\"connectAnd\")}`;");
    expect(src("sunday-page.tsx")).toContain("your decision here didn't change anything there.");
    expect(src("church-system.ts")).toContain("your decision here didn't change anything there.");
    // The change flow's own reads are listed where Ozzie says what it reads, before any of it happens.
    expect(src("first-run-screens.tsx")).toContain("adding someone to a team marked as a kids team first reads that person's background check status and end date (cleared and unfinished checks), even when that rule is off.");
    expect(src("first-run-screens.tsx")).toContain("whether Planning Center lists them as a child and as active, read just before the change.");
    expect(src("kids-rules-section.tsx")).toContain("adding someone to one of these teams also reads that person's background check status and end date first, even with this off.");
    // No absolute claim about Planning Center is left anywhere on the page. A line said only for a church on another
    // system (which Ozzie only reads) or for something that only reads whatever the switch says is listed here, with why.
    const forOtherSystemsOrReadsOnly = [
      // promises.ts form A: a job, a scheduled check, and another system's own promise.
      /^\s*(?:A|reads): "It only reads\. It never changes anything in Planning Center\.",$/u,
      // sunday-page.tsx: a decided lead on another system, said in its name (w.say); Planning Center's line is NO_LEAD_TEXT.
      /w\.system === "planning-center" \? NO_LEAD_TEXT : w\.say\("Planning Center still shows no confirmed lead; Ozzie hasn't changed anything there\."\)/u,
      // church-system.ts: another system's own count line (Planning Center's is above it, and says the leader's decision).
      /^\s*remaining: \(n: number\) => `By \$\{name\}'s numbers, /u,
    ];
    for (const p of ALL.filter(x => x.startsWith("product/desktop/src/"))) {
      const lines = source(p).split("\n").filter(l => !forOtherSystemsOrReadsOnly.some(r => r.test(l)));
      expect(lines.join("\n"), p).not.toMatch(/has no way to change records|never changes anything in Planning Center|Ozzie hasn't changed anything there|Ozzie only reads; it changes nothing there\./u);
    }
  });
});

describe("review X: a blink of the connection, every Add waiting, Escape, and the words that changed", () => {
  beforeEach(() => { native.calls.length = 0; focusedOn.el = null; });

  it("M-A: connected false then true keeps Take … off again and the quit list (native code still holds the row)", async () => {
    const m = await mount(answers({ ...on, change_prepare: () => proposal(), change_confirm: () => ({ result: "made", record: record() }) }));
    await m.press(addButton("Riley", "Greeter"));
    await m.press(yesAdd("Riley", false));
    await m.act(async () => { m.root.render("check-2"); });
    expect(dom.button(takeOff("Riley"))).not.toBeNull();
    expect(lastControl.c?.undoable).toEqual(["Riley"]);
    // One status poll of a renewal: not connected. Undo stays; no new Add is offered meanwhile.
    await m.act(async () => { m.root.render("check-2", false); });
    await m.act(flush);
    expect(dom.button(takeOff("Riley"))).not.toBeNull();
    expect(lastControl.c?.undoable).toEqual(["Riley"]);
    expect(dom.button(addButton("Drew", "Greeter"))).toBeNull();
    // Connected again: the switch is read again, still on, and nothing was forgotten.
    const before = native.calls.filter(c => c.command === "changes_status").length;
    await m.act(async () => { m.root.render("check-2", true); });
    await m.act(flush);
    expect(native.calls.filter(c => c.command === "changes_status").length).toBe(before + 1);
    expect(dom.button(takeOff("Riley"))).not.toBeNull();
    expect(lastControl.c?.undoable).toEqual(["Riley"]);
    expect(dom.button(addButton("Drew", "Greeter"))).not.toBeNull();
    await m.act(async () => { m.root.unmount(); });
  });

  it("M-A: Disconnect (no saved sign-in left) is a church left: Take … off again and the quit list go at once", async () => {
    const m = await mount(answers({ ...on, change_prepare: () => proposal(), change_confirm: () => ({ result: "made", record: record() }) }));
    await m.press(addButton("Riley", "Greeter"));
    await m.press(yesAdd("Riley", false));
    expect(lastControl.c?.undoable).toEqual(["Riley"]);
    await m.act(async () => { m.root.render("check-2", false, true); });
    await m.act(flush);
    expect(dom.button(takeOff("Riley"))).toBeNull();
    expect(lastControl.c?.results).toEqual([]);
    expect(lastControl.c?.undoable).toEqual([]);
    await m.act(async () => { m.root.unmount(); });
  });

  it("M-A: when native code says the switch is off, what it made is gone here too", async () => {
    let isOn = true;
    const m = await mount(answers({ changes_status: () => ({ organization: "1001", on: isOn }), change_prepare: () => proposal(), change_confirm: () => ({ result: "made", record: record() }) }));
    await m.press(addButton("Riley", "Greeter"));
    await m.press(yesAdd("Riley", false));
    isOn = false;
    await m.act(async () => { m.root.render("check-2", false); });
    await m.act(async () => { m.root.render("check-2", true); });
    await m.act(flush);
    expect(lastControl.c?.on).toBe(false);
    expect(lastControl.c?.results).toEqual([]);
    expect(lastControl.c?.undoable).toEqual([]);
    await m.act(async () => { m.root.unmount(); });
  });

  it("M-A: a blink while Checking Planning Center… doesn't drop the answer: the confirmation shows once it comes", async () => {
    let answer!: (p: Proposed) => void;
    const m = await mount(answers({ ...on, change_prepare: () => new Promise<Proposed>(r => { answer = r; }) }));
    await m.press(addButton("Riley", "Greeter"));
    expect(dom.seen()).toContain("Checking Planning Center…");
    await m.act(async () => { m.root.render("check-1", false); });
    await m.act(async () => { answer(proposal()); });
    await m.act(flush);
    await m.act(async () => { m.root.render("check-1", true); });
    await m.act(flush);
    expect(dom.seen()).toContain(confirmTitle("Riley Thornbury", "Sunday Morning", "Sunday, Nov 22"));
    await m.act(async () => { m.root.unmount(); });
  });

  it("L-e: an undo refused while not connected keeps Take … off again", () => {
    const u: Undone = { result: "not-removed", reason: "not-connected" };
    expect(mayTryUndoAgain(u)).toBe(true);
    expect(undoSentence(u, said)).toBe(refusalSentence("not-connected", said));
  });

  it("L-i: after a change every Add on the page waits behind Checking Planning Center again…, not only the changed role's", () => {
    // Another role was changed: Greeter's people stay, its Add buttons wait, and the line says why.
    const t = text(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs("live")), changes: slot(control({ rechecks: { "92902197": { plan: "92902197", key: "another-role", failed: false, since: null } } })) })));
    expect(t).toContain("Riley Thornbury");
    expect(t).toContain(RECHECKING);
    expect(t).not.toContain("in Planning Center…");
    const failed = text(renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs("live")), changes: slot(control({ rechecks: { "92902197": { plan: "92902197", key: "another-role", failed: true, since: null } } })) })));
    expect(failed).toContain(RECHECK_FAILED);
    expect(failed).not.toContain("in Planning Center…");
  });

  it("L-k: Escape closes a refusal, and cancels Checking… (its answer, if it still comes, is dropped)", async () => {
    const m = await mount(answers({ ...on, change_prepare: () => Promise.reject("role-not-open") }));
    await m.press(addButton("Riley", "Greeter"));
    const panel = byClass("change-refused")!;
    expect(panel).not.toBeNull();
    await m.act(async () => { props(panel).onKeyDown!({ key: "Escape", stopPropagation() {} }); });
    await m.act(flush);
    expect(byClass("change-refused")).toBeNull();
    expect(focusedOn.el?.textContent).toBe(addButton("Riley", "Greeter"));
    await m.act(async () => { m.root.unmount(); });

    let answer!: (p: Proposed) => void;
    const n = await mount(answers({ ...on, change_prepare: () => new Promise<Proposed>(r => { answer = r; }) }));
    await n.press(addButton("Riley", "Greeter"));
    const status = byClass("change-status")!;
    expect(status.textContent).toBe("Checking Planning Center…");
    await n.act(async () => { props(status).onKeyDown!({ key: "Escape", stopPropagation() {} }); });
    await n.act(async () => { answer(proposal()); });
    await n.act(flush);
    expect(dom.seen()).not.toContain("Checking Planning Center…");
    expect(dom.seen()).not.toContain(confirmTitle("Riley Thornbury", "Sunday Morning", "Sunday, Nov 22"));
    expect(dom.button(addButton("Riley", "Greeter"))).not.toBeNull();
    expect(native.calls.some(c => c.command === "change_confirm")).toBe(false);
    await n.act(async () => { n.root.unmount(); });
  });

  it("unknown answers claim neither that Ozzie couldn't look nor what it saw", () => {
    // L-Y4: true for no answer, a 5xx, a 2xx without the row's id, and a 204 whose read back failed or still shows the row.
    expect(outcomeSentence({ result: "unknown" }, said)).toBe(`Planning Center's answer didn't make clear whether the change was made. ${notKnown("Riley")}`);
    expect(undoSentence({ result: "unknown" }, said)).toBe("Ozzie couldn't confirm whether Riley is still on the plan. Open the plan to see.");
    expect(historyLine(record({ came_back: "unknown" }), "Riley Thornbury")).toBe(
      "You added Riley Thornbury to Greeter on Sunday, Nov 29 as unconfirmed, with the request waiting. Planning Center's answer didn't make clear whether it was made.");
    expect(historyLine(record({ action: "took-off", came_back: "unknown" }), "Riley Thornbury")).toBe(
      "You took Riley Thornbury off Greeter on Sunday, Nov 29. Planning Center's answer didn't make clear whether it was done.");
    for (const x of [outcomeSentence({ result: "unknown" }, said), undoSentence({ result: "unknown" }, said),
      historyLine(record({ came_back: "unknown" }), "a person"), historyLine(record({ action: "took-off", came_back: "unknown" }), "a person")]) {
      expect(x).not.toMatch(/couldn't look again|nothing changed/iu);
    }
  });

  it("Church rules says which read the background-check sentence is about, and keeps the adding-people one", () => {
    const kids = source("product/desktop/src/kids-rules-section.tsx");
    expect(kids).toContain("For each check of your services, Ozzie reads only whether each person scheduled on these teams has a current background check in Planning Center People, never its details.");
    expect(kids).toContain("adding someone to one of these teams also reads that person's background check status and end date first, even with this off.");
  });
});

describe("review Y: What happened whatever the sign-in's state, answers from before a church change, and the words that changed", () => {
  beforeEach(() => { native.calls.length = 0; focusedOn.el = null; });
  const NONE_YET = "No changes yet. Each one you confirm is listed here.";
  const UNAVAILABLE = "Ozzie's list of changes isn't available right now.";
  const line = (r: ChangeRecord) => historyLine(r, "Riley Thornbury");

  // Renewing, failed and expired all reach the page the same way: App counts only connected (or stored-unchecked) as
  // connected, and only "disconnected" as Disconnect. Native code reads the list from the church whatever the state.
  for (const state of ["renewing", "failed", "expired"]) {
    it(`M-Y1: with the sign-in ${state}, What happened lists the changes (native code reads them from the church), never "No changes yet"`, async () => {
      const m = await mount(answers({ ...on, change_history: () => [record()] }));
      await m.act(async () => { m.root.render("check-1", true, false, { showingHistory: true }); });
      await m.act(flush);
      expect(dom.seen()).toContain(line(record()));
      await m.act(async () => { m.root.render("check-1", false, false, { showingHistory: true }); });
      await m.act(flush);
      expect(dom.seen()).toContain(line(record()));
      expect(dom.seen()).not.toContain(NONE_YET);
      await m.act(async () => { m.root.unmount(); });
    });
  }

  it("M-Y1: a list already shown stays through a blink whose read fails; a first read that fails says it isn't available, never No changes yet", async () => {
    let fail = false;
    const m = await mount(answers({ ...on, change_history: () => fail ? Promise.reject("not-connected") : [record()] }));
    await m.act(async () => { m.root.render("check-1", true, false, { showingHistory: true }); });
    await m.act(flush);
    fail = true;
    await m.act(async () => { m.root.render("check-1", false, false, { showingHistory: true }); });
    await m.act(flush);
    expect(native.calls.filter(c => c.command === "change_history").length).toBe(2);
    expect(dom.seen()).toContain(line(record()));
    expect(dom.seen()).not.toContain(NONE_YET);
    await m.act(async () => { m.root.unmount(); });

    const n = await mount(answers({ ...on, change_history: () => Promise.reject("unavailable") }));
    await n.act(async () => { n.root.render("check-1", true, false, { showingHistory: true }); });
    await n.act(flush);
    expect(dom.seen()).toContain(UNAVAILABLE);
    expect(dom.seen()).not.toContain(NONE_YET);
    await n.act(async () => { n.root.unmount(); });
  });

  it("M-Y1: connected again, the list is read again and shows what native code has now", async () => {
    let list = [record()];
    const m = await mount(answers({ ...on, change_history: () => list }));
    await m.act(async () => { m.root.render("check-1", true, false, { showingHistory: true }); });
    await m.act(flush);
    await m.act(async () => { m.root.render("check-1", false, false, { showingHistory: true }); });
    await m.act(flush);
    list = [record({ action: "took-off", came_back: "removed" }), record()];
    const before = native.calls.filter(c => c.command === "change_history").length;
    await m.act(async () => { m.root.render("check-1", true, false, { showingHistory: true }); });
    await m.act(flush);
    expect(native.calls.filter(c => c.command === "change_history").length).toBe(before + 1);
    expect(dom.seen()).toContain(line(record({ action: "took-off", came_back: "removed" })));
    // Only an empty list from native code says No changes yet.
    list = [];
    await m.act(async () => { m.root.render("check-1", false, false, { showingHistory: true }); });
    await m.act(flush);
    expect(dom.seen()).toContain(NONE_YET);
    await m.act(async () => { m.root.unmount(); });
    expect(source("product/desktop/src/App.tsx")).toContain(`showingHistory: page === "activity", disconnectTries });`);
  });

  /** Native code for two churches, both with the switch on: changes_status answers for whichever church is asked about. */
  const church = { now: "1001" };
  const twoChurches = (more: Record<string, (args: Record<string, unknown> | undefined) => unknown>) =>
    answers({ changes_status: () => ({ organization: church.now, on: true }), change_prepare: () => proposal(), ...more });
  const toChurch = async (m: Awaited<ReturnType<typeof mount>>, org: string) => {
    church.now = org;
    await m.act(async () => { m.root.render("check-1", true, false, { organization: org }); });
    await m.act(flush);
  };

  it("L-Y6: switching from 1001 to 2002 lets go of 1001's results and the quit list", async () => {
    church.now = "1001";
    const m = await mount(twoChurches({ change_confirm: () => ({ result: "made", record: record() }) }));
    await m.press(addButton("Riley", "Greeter"));
    await m.press(yesAdd("Riley", false));
    expect(lastControl.c?.undoable).toEqual(["Riley"]);
    await toChurch(m, "2002");
    expect(lastControl.c?.on).toBe(true);
    expect(lastControl.c?.results).toEqual([]);
    expect(lastControl.c?.undoable).toEqual([]);
    expect(dom.button(takeOff("Riley"))).toBeNull();
    await m.act(async () => { m.root.unmount(); });
  });

  it("L-Y1: a yes answered after a church switch adds no result, no Take … off again and no fresh check under the new church", async () => {
    church.now = "1001";
    let answer!: (o: Outcome) => void;
    const m = await mount(twoChurches({ change_confirm: () => new Promise<Outcome>(r => { answer = r; }) }));
    await m.press(addButton("Riley", "Greeter"));
    await m.act(async () => { dom.press(dom.button(yesAdd("Riley", false))!); });
    await toChurch(m, "2002");
    await m.act(async () => { answer({ result: "made", record: record() }); });
    await m.act(flush);
    expect(lastControl.c?.results).toEqual([]);
    expect(lastControl.c?.undoable).toEqual([]);
    expect(dom.button(takeOff("Riley"))).toBeNull();
    expect(m.afterWrite).not.toHaveBeenCalled();
    await m.act(async () => { m.root.unmount(); });
  });

  it("L-Y1: a look answered after a church switch opens no card under the new church", async () => {
    church.now = "1001";
    let answer!: (p: Proposed) => void;
    const m = await mount(twoChurches({ change_prepare: () => new Promise<Proposed>(r => { answer = r; }) }));
    await m.press(addButton("Riley", "Greeter"));
    await toChurch(m, "2002");
    await m.act(async () => { answer(proposal()); });
    await m.act(flush);
    expect(lastControl.c?.open).toBeNull();
    expect(dom.seen()).not.toContain(confirmTitle("Riley Thornbury", "Sunday Morning", "Sunday, Nov 22"));
    await m.act(async () => { m.root.unmount(); });
  });

  it("L-Y1: a take-off answered after a church switch changes nothing shown under the new church", async () => {
    church.now = "1001";
    let answer!: (u: Undone) => void;
    const m = await mount(twoChurches({ change_confirm: () => ({ result: "made", record: record() }), change_undo: () => new Promise<Undone>(r => { answer = r; }) }));
    await m.press(addButton("Riley", "Greeter"));
    await m.press(yesAdd("Riley", false));
    await m.press(takeOff("Riley"));
    const writes = m.afterWrite.mock.calls.length;
    await toChurch(m, "2002");
    await m.act(async () => { answer({ result: "removed" }); });
    await m.act(flush);
    expect(lastControl.c?.results).toEqual([]);
    expect(dom.seen()).not.toContain(undoSentence({ result: "removed" }, said));
    expect(dom.seen()).not.toContain("took Riley off again");
    expect(m.afterWrite.mock.calls.length).toBe(writes);
    await m.act(async () => { m.root.unmount(); });
  });

  it("L-Y2: taking someone off closes any confirmation still open (native code dropped that change)", async () => {
    const m = await mount(answers({ ...on, change_prepare: () => proposal({ person: PEOPLE.drew }), change_confirm: () => ({ result: "made", record: record() }), change_undo: () => ({ result: "removed" }) }));
    await m.press(addButton("Riley", "Greeter"));
    await m.press(yesAdd("Riley", false));
    await m.press(addButton("Drew", "Greeter"));
    expect(lastControl.c?.open?.stage).toBe("proposed");
    await m.press(takeOff("Riley"));
    expect(lastControl.c?.open).toBeNull();
    expect(byClass("change-card")).toBeNull();
    await m.act(async () => { m.root.unmount(); });
  });

  it("L-Y5: not connected, for an add or a take-off, says try again in a moment, and Take … off again stays", () => {
    const sentence = "Nothing changed. Planning Center isn't connected just now. Try again in a moment; if it still isn't, connect it in Settings.";
    expect(refusalSentence("not-connected", said)).toBe(sentence);
    expect(undoSentence({ result: "not-removed", reason: "not-connected" }, said)).toBe(sentence);
    expect(mayTryUndoAgain({ result: "not-removed", reason: "not-connected" })).toBe(true);
  });

  it("L-Y7: What happened says an end date on or before that Sunday as Planning Center showed it", () => {
    expect(historyLine(record({ despite_advice: "expires-by-that-sunday" }), "Riley Thornbury"))
      .toContain("Ozzie had advised against it: Planning Center showed Riley's background check on file had an end date on or before that service's day. You chose to go ahead.");
  });

  it("L-Y4: no sentence a clear 2xx can reach says Planning Center didn't answer in time", () => {
    for (const x of [outcomeSentence({ result: "unknown" }, said), outcomeSentence({ result: "nothing-changed" }, said), outcomeSentence({ result: "several-rows" }, said),
      outcomeSentence({ result: "made-after-all", record: record() }, said), undoSentence({ result: "unknown" }, said),
      line(record({ came_back: "unknown" })), line(record({ came_back: "made-after-all" })), line(record({ came_back: "nothing-changed" })),
      line(record({ came_back: "several-rows" })), line(record({ action: "took-off", came_back: "unknown" }))]) {
      expect(x).not.toMatch(/in time|couldn't look again/u);
    }
  });
});

describe("the result card after a take-off says only what is true now (live test)", () => {
  const ADDED = "2026-11-20T19:03:00.000Z", OFF = "2026-11-20T19:04:00.000Z";
  const PAST = "You added Riley to Greeter as unconfirmed at 2:03 PM.";
  const MADE = outcomeSentence({ result: "made", record: record() }, said);
  const card = (over: Partial<ChangeResult>): ChangeResult => ({ id: 1, ask: greeterAsk, plan: "92902197", day: "2026-11-22", sentence: MADE, tone: "made", row: "88001", undo: "done",
    addedAt: ADDED, answer: null, offAt: null, ...over });
  /** The result card as the Sunday page draws it (church zone America/New_York): its badge and its lines. */
  const drawn = (r: ChangeResult) => {
    const html = renderToStaticMarkup(React.createElement(SundayPage, { ...pageProps(briefAs("live")), changes: slot(control({ results: [r] })) }));
    const article = html.slice(html.indexOf('<article class="find change-result'), html.indexOf("</article>") + "</article>".length);
    return { badge: text(/<span class="badge [^"]+">(?:(?!<\/span>).)*<\/span>/u.exec(article.replace(/<svg[^]*?<\/svg>/gu, ""))![0]).trim(),
      lines: [...article.matchAll(/<p class="find-body"[^>]*>([^<]*)<\/p>/gu)].map(m => m[1]!.replaceAll("&#x27;", "'")), all: text(article) };
  };
  const after = (answer: ChangeResult["answer"], undo: ChangeResult["undo"] = "done") => drawn(card({ answer, offAt: OFF, undo }));

  it("before any take-off answer: the add's own sentence and badge", () => {
    expect(drawn(card({ undo: "can" }))).toMatchObject({ badge: "Changed in Planning Center", lines: [MADE] });
  });
  it("removed: one sentence with both times, badge Not on the plan", () => {
    expect(after({ result: "removed" })).toMatchObject({ badge: "Not on the plan",
      lines: ["You added Riley to Greeter at 2:03 PM and took Riley off again at 2:04 PM. The Greeter place is open again; the request was never sent."] });
  });
  it("made after all, then removed: the same one sentence", () => {
    const r = card({ sentence: outcomeSentence({ result: "made-after-all", record: record({ came_back: "made-after-all" }) }, said), answer: { result: "removed" }, offAt: OFF });
    expect(drawn(r).lines).toEqual(["You added Riley to Greeter at 2:03 PM and took Riley off again at 2:04 PM. The Greeter place is open again; the request was never sent."]);
  });
  it("already gone: the add in the past, then the already-gone fact, badge Not on the plan", () => {
    expect(after({ result: "already-gone" })).toMatchObject({ badge: "Not on the plan",
      lines: [PAST, "When Ozzie went to take Riley off at 2:04 PM, Riley was already off the Sunday Morning plan for Sunday, Nov 22 in Planning Center, so there was nothing to take off."] });
  });
  it("unknown, and an answer that never reached the page: the add in the past, then what isn't known, badge Worth a look", () => {
    expect(after({ result: "unknown" })).toMatchObject({ badge: "Worth a look", lines: [PAST, "Ozzie couldn't confirm whether Riley is still on the plan. Open the plan to see."] });
    expect(after({ result: "not-known" })).toMatchObject({ badge: "Worth a look", lines: [PAST, "Ozzie couldn't tell whether Planning Center took Riley off. Open the plan in Planning Center to see."] });
  });
  it("refused by Planning Center (403 and others): the add in the past, then nothing changed, badge Worth a look", () => {
    expect(after({ result: "refused-by-planning-center", status: 403, not_allowed: true })).toMatchObject({ badge: "Worth a look",
      lines: [PAST, "Nothing changed. Planning Center says your account can't change people on this team, so Riley wasn't taken off. You can change it in Planning Center."] });
    expect(after({ result: "refused-by-planning-center", status: 422, not_allowed: false })).toMatchObject({ badge: "Worth a look",
      lines: [PAST, "Nothing changed. Planning Center didn't accept taking Riley off. You can change it in Planning Center."] });
  });
  it("every refusal, passing or not: the add in the past, then the refusal's own sentence, badge Changed in Planning Center", () => {
    for (const reason of REFUSALS) {
      const u: Undone = { result: "not-removed", reason };
      const d = after(u, mayTryUndoAgain(u) ? "can" : "done");
      expect(d.badge, reason).toBe("Changed in Planning Center");
      expect(d.lines, reason).toEqual([PAST, undoSentence(u, said)]);
      // The button stays for a refusal that passes; Hide only once it can't work.
      expect(d.all.includes(takeOff("Riley")), reason).toBe(mayTryUndoAgain(u));
      expect(d.all.includes("Hide this"), reason).toBe(!mayTryUndoAgain(u));
    }
    expect(after({ result: "not-removed", reason: "request-already-sent" }).lines[1]).toBe("Nothing changed. Riley has been sent a request, and Ozzie can't take that back. You can change it in Planning Center.");
    expect(after({ result: "not-removed", reason: "not-connected" }, "can").lines[1]).toBe("Nothing changed. Planning Center isn't connected just now. Try again in a moment; if it still isn't, connect it in Settings.");
  });
  it("trying again after a refusal: only the add in the past while it runs", () => {
    expect(after({ result: "not-removed", reason: "busy-with-a-check" }, "working").lines).toEqual([PAST]);
  });
  it("several rows, and an add whose answer is unknown: one sentence, no take-off, nothing stacked", () => {
    for (const o of [{ result: "several-rows" } as const, { result: "unknown" } as const]) {
      const d = drawn(card({ sentence: outcomeSentence(o, said), tone: "look", row: null, undo: "none", addedAt: null }));
      expect(d.badge).toBe("Worth a look");
      expect(d.lines).toEqual([outcomeSentence(o, said)]);
      expect(d.all).not.toContain(takeOff("Riley"));
    }
  });
  it("after any take-off answer the card never says Riley is on the plan (alongside off the plan or at all)", () => {
    const answers: ChangeResult["answer"][] = [{ result: "removed" }, { result: "already-gone" }, { result: "unknown" }, { result: "not-known" },
      { result: "refused-by-planning-center", status: 403, not_allowed: true }, { result: "refused-by-planning-center", status: 500, not_allowed: false },
      ...REFUSALS.map(reason => ({ result: "not-removed" as const, reason }))];
    for (const a of answers) {
      const d = after(a);
      expect(d.all, a!.result).not.toContain(`Riley is on ${PLAN_WORDS}`);
      expect(d.all.includes(`Riley is on ${PLAN_WORDS}`) && d.all.includes(`off ${PLAN_WORDS}`), a!.result).toBe(false);
    }
  });
});

describe("a Disconnect that failed (live), and one rule for the lines about reading", () => {
  beforeEach(() => { native.calls.length = 0; });

  it("every reads-only line takes its on form only while connected and the switch is on (App.tsx)", () => {
    const app = source("product/desktop/src/App.tsx");
    expect(app).toContain("const changesShownOn = connected && changesOn;");
    expect(app).toContain("{changesShownOn ? SIDEBAR_ON\n");
    expect(app).toContain("? { lede: changesShownOn ? ACTIVITY_LEDE_ON : null, section: <ChangeHistory");
    expect(app).toContain("banner: changesShownOn ? SETTINGS_BANNER_ON : null } : undefined}");
    // None of the three follows the switch alone any more. First run shows before any church exists: the build's form B.
    for (const old of ["changesOn ? SIDEBAR_ON", "changesOn ? SETTINGS_BANNER_ON"]) expect(app).not.toContain(old);
    expect(app).not.toContain("{ lede: ACTIVITY_LEDE_ON");
  });

  it("not connected with the switch on: What happened keeps its list, with the off-form lede, whose words hold then", () => {
    const html = text(renderToStaticMarkup(React.createElement(ActivityPage, { capture, tasks: [], now: new Date("2026-11-20T16:00:00Z"),
      changes: { lede: null, section: React.createElement(ChangeHistory, { records: [record()], names }) } })));
    const OFF_LEDE = `${promise("reads")} ${promise("sends")}`;
    expect(html).toContain(OFF_LEDE);
    expect(html).toContain(historyLine(record(), "Riley Thornbury"));
    expect(html).not.toContain(ACTIVITY_LEDE_ON);
    // Each off form is the build's form B (promises.ts), said as a condition, so it is true with the switch on in the file
    // but nothing connected, and with the switch off.
    for (const name of ["reads", "readsShort", "still", "connectAnd", "connectReads"] as const) {
      expect(promise(name), name).toMatch(/unless you confirm|only what you confirm|haven't confirmed/u);
    }
  });

  it("a Disconnect that fails, then native reporting off, leaves no Take-off button, an empty quit list and the switch shown off", async () => {
    let isOn = true;
    const m = await mount(answers({ changes_status: () => ({ organization: "1001", on: isOn }), change_prepare: () => proposal(), change_confirm: () => ({ result: "made", record: record() }) }));
    await m.press(addButton("Riley", "Greeter"));
    await m.press(yesAdd("Riley", false));
    await m.act(async () => { m.root.render("check-2"); });
    expect(dom.button(takeOff("Riley"))).not.toBeNull();
    // Disconnect was tried and failed: the connection reads as before, but native code turned changes off.
    isOn = false;
    await m.act(async () => { m.root.render("check-2", true, false, { disconnectTries: 1 }); });
    await m.act(flush);
    expect(dom.button(takeOff("Riley"))).toBeNull();
    expect(lastControl.c?.undoable).toEqual([]);
    expect(lastControl.c?.on).toBe(false);
    expect(renderToStaticMarkup(React.createElement(ChangesSwitch, { control: lastControl.c!, church: null, people: true }))).not.toContain('checked=""');
    // The same with the connection gone to "failed" (not connected): the switch is still read again.
    await m.act(async () => { m.root.unmount(); });
    isOn = true;
    const n = await mount(answers({ changes_status: () => ({ organization: "1001", on: isOn }), change_prepare: () => proposal(), change_confirm: () => ({ result: "made", record: record() }) }));
    await n.press(addButton("Riley", "Greeter"));
    await n.press(yesAdd("Riley", false));
    isOn = false;
    const before = native.calls.filter(c => c.command === "changes_status").length;
    await n.act(async () => { n.root.render("check-1", false, false, { disconnectTries: 1 }); });
    await n.act(flush);
    expect(native.calls.filter(c => c.command === "changes_status").length).toBe(before + 1);
    expect(lastControl.c?.undoable).toEqual([]);
    expect(dom.button(takeOff("Riley"))).toBeNull();
    await n.act(async () => { n.root.unmount(); });
  });

  it("Disconnect tells App it was tried even when it fails (the Keychain refused), so the switch is read again", async () => {
    native.answer = (command: string) => command === "disconnect_planning_center" ? Promise.reject({ code: "store" }) : Promise.reject("unavailable");
    const tried = vi.fn();
    const status = { state: "connected", organization: "1001", checked_at_ms: 1, source: "", problem: null, scopes: null } as unknown as ConnectionStatus;
    const settings = { clientId: "", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
    function Form() {
      const control = useConnectionControl(settings, () => undefined, status, true);
      return React.createElement(ConnectForm, { status, settings, onSettings: () => undefined, control, onDisconnectTried: tried });
    }
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const box = dom.root.appendChild((document as unknown as { createElement(t: string): typeof dom.root }).createElement("div"));
    const root = createRoot(box as unknown as Element);
    await act(async () => { root.render(React.createElement(Form)); });
    await act(async () => { dom.press(dom.button(DISCONNECT)!); });
    await act(flush);
    expect(native.calls.some(c => c.command === "disconnect_planning_center")).toBe(true);
    expect(tried).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
    dom.root.removeChild(box);
    for (const f of ["connection-page.tsx", "setup-flow.tsx"]) expect(source(`product/desktop/src/${f}`), f).toContain("onDisconnectTried={onDisconnectTried}");
    // Settings and first run; and leaving Planning Center for another system reads the switch again too.
    expect(source("product/desktop/src/App.tsx").split("onDisconnectTried={() => setDisconnectTries(n => n + 1)}").length - 1).toBe(2);
    expect(source("product/desktop/src/App.tsx")).toContain("const after = await connection.disconnect().catch(() => null).finally(() => setDisconnectTries(n => n + 1));");
    expect(source("product/desktop/src/setup-flow.tsx")).toContain(".finally(() => { setWorking(false); onDisconnectTried?.(); });");
  });
});

describe("the change code stays on the page: nothing that reaches a model, a notice, Siri, other AI apps or a schedule can reach it", () => {
  const CHANGES = "product/desktop/src/planning-center-changes.ts";
  const CARD = "product/desktop/src/change-card.tsx";
  const APP = "product/desktop/src/App.tsx";
  const COMMANDS = ["changes_status", "changes_set", "change_prepare", "change_confirm", "change_undo", "change_history"];
  /** Commands that reach a model, send a notice, write the copy for other AI apps or Siri, or carry text off the page. */
  const OUTWARD = ["reword_draft", "agent_step", "responsibility_agent_step", "share_last_check", "notify_sunday_attention", "notify_ozzie", "managed_connect",
    "save_shortcuts_check", "speak_briefing", "open_draft", "open_draft_to", "phone_notice_test"];

  it("native code registers each command, and only planning-center-changes.ts names them, anywhere in the app's source", () => {
    expect(ALL).toContain(CHANGES);
    for (const c of COMMANDS) expect(NATIVE_COMMANDS, c).toContain(c);
    for (const c of COMMANDS) expect(ALL.filter(p => source(p).includes(c)), c).toEqual([CHANGES]);
  });

  // The first walk of the whole app's imports parses every file (about 9 s on a loaded machine): its own time limit.
  it("is imported by App and the change card alone, and the card by App alone", () => {
    expect(ALL.filter(p => imports(p).includes(CHANGES)).sort()).toEqual([APP, CARD]);
    expect(ALL.filter(p => imports(p).includes(CARD))).toEqual([APP]);
  }, 120_000);

  it("nothing else in the app reaches it, even indirectly: not the harness, Ask, the AI's tools, the shared check, Siri, notices, jobs, autopilot or the quit question", () => {
    const reachers = ALL.filter(p => reach(p).has(CHANGES)).sort();
    expect(reachers).toEqual([APP, CARD, "product/desktop/src/main.tsx", CHANGES].sort());
    for (const p of ["product/desktop/src/harness-bridge.ts", "product/desktop/src/harness-words.ts", "product/desktop/src/ask-panel.tsx", "product/desktop/src/model.ts",
      "product/desktop/src/share-check.ts", "product/desktop/src/siri-shortcuts.ts", "product/desktop/src/phone-notice.ts", "product/desktop/src/responsibility-runner.ts",
      "product/desktop/src/autopilot.ts", "product/desktop/src/proactive.ts", "product/desktop/src/background.ts", "product/desktop/src/sunday-page.tsx",
      "product/desktop/src/sunday-ready.tsx", "product/desktop/src/today-page.tsx", "product/desktop/src/activity-page.tsx", "product/desktop/src/connection-page.tsx",
      "product/desktop/src/quit-question.tsx"]) {
      expect(ALL, p).toContain(p);
      expect(reach(p).has(CHANGES), p).toBe(false);
      expect(reach(p).has(CARD), p).toBe(false);
    }
    for (const p of ALL.filter(x => x.startsWith("core/src/harness/") || x.startsWith("core/mcp/"))) expect(reach(p).has(CHANGES), p).toBe(false);
  });

  it("the module imports nothing of the app's, talks to native code only through Tauri's invoke, and has no other way off the page", () => {
    expect(imports(CHANGES)).toEqual([]);
    expect(specifiers(CHANGES).map(s => s.spec)).toEqual(["@tauri-apps/api/core"]);
    expect(source(CHANGES)).not.toMatch(OFF_THE_PAGE_APIS);
    for (const c of NATIVE_COMMANDS.filter(c => !COMMANDS.includes(c))) expect(namesCommand(source(CHANGES), c), c).toBe(false);
  });

  it("the card, and everything it imports, names no command that sends anything anywhere", () => {
    for (const p of reach(CARD, false)) {
      for (const c of OUTWARD) expect(namesCommand(source(p), c), `${p} names ${c}`).toBe(false);
      expect(source(p), p).not.toMatch(OFF_THE_PAGE_APIS);
    }
    expect([...reach(CARD, false)].sort()).toEqual([CARD, "product/desktop/src/icons.tsx", "product/desktop/src/planning-center-pages.ts", CHANGES].sort());
  });

  it("asks native code for a change only from a person's click: the hook's calls sit inside the controls the page's buttons use", () => {
    const card = source(CARD);
    // Only the switch's state is read without a click; a change, a yes and an undo are each one call in its own control.
    for (const call of ["changes.prepare(", "changes.confirm(", "changes.undo(", "changes.set("]) expect(card.split(call).length - 1, call).toBe(1);
    expect(card).toMatch(/ask: a => \{[^]*?changes\.prepare\(/u);
    expect(card).toMatch(/confirm: despite => \{[^]*?changes\.confirm\(/u);
    expect(card).toMatch(/undo: id => \{[^]*?changes\.undo\(/u);
  });

  it("the commands go out with exactly the contract's arguments", async () => {
    native.calls.length = 0;
    native.answer = () => Promise.resolve({});
    await changes.status();
    await changes.set(true);
    await changes.prepare({ plan: "92902197", team: "7593350", position: "Greeter", person: "511", kidsTeamIds: ["7593352"] });
    await changes.confirm("0123456789abcdef0123456789abcdef");
    await changes.confirm("0123456789abcdef0123456789abcdef", "pending");
    await changes.undo("88001");
    await changes.history(20);
    expect(native.calls).toEqual([
      { command: "changes_status", args: undefined },
      { command: "changes_set", args: { on: true } },
      { command: "change_prepare", args: { plan: "92902197", team: "7593350", position: "Greeter", person: "511", kidsTeamIds: ["7593352"] } },
      { command: "change_confirm", args: { change: "0123456789abcdef0123456789abcdef" } },
      { command: "change_confirm", args: { change: "0123456789abcdef0123456789abcdef", despiteAdvice: "pending" } },
      { command: "change_undo", args: { row: "88001" } },
      { command: "change_history", args: { limit: 20 } },
    ]);
  });
});
