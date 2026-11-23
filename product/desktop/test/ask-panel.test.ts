import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { REFUSALS } from "../../../core/src/ask.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { ChooseAiContext } from "../src/ai-line.js";
import { NEEDS_AI } from "../src/ai-words.js";
import { Answer, ASK_ABOUT, ASK_INTRO, ASK_NOTE, AskCard, AskPanel, EARLIER_SHOWN, HowItWorks, isCardsRequest, isHelpRequest, routeQuestion, TurnBody, turnAnnouncement, type Turn } from "../src/ask-panel.js";
import type { Parsed } from "../../../core/src/harness/responsibilities.js";
import { App } from "../src/App.js";
import { askOzzie, createAppHarness, type AskTurn, type ShownAnswer } from "../src/harness-bridge.js";
import { ASK_FAILURES, ASK_START } from "../src/harness-words.js";
import { DayProvider } from "../src/day-words.js";
import { wednesdayCapture, wednesdayWords } from "../../../core/test/fixtures/service-days/wednesday.js";
import { BACKGROUND_IN_REQUEST, draftTurns, everyRequest, fictionalData, greeterTurns, HIDDEN_WORDS, scripted, text } from "./harness-fakes.js";

const skills = await bundledSkills();
const capture = nov22Capture();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const fictional = buildSundayBrief(capture, rules, capture.completed_at, true);
const never = () => new Promise<AskTurn>(() => {});
const panel = (over: Partial<React.ComponentProps<typeof AskPanel>> = {}) => renderToStaticMarkup(React.createElement(AskPanel, {
  open: true, onClose: () => {}, ask: never, brief: fictional, modelReady: true, onOpen: () => {}, ...over,
}));
const note = ASK_NOTE.replaceAll("'", "&#x27;");
/** A real answer: the fictional example through the harness with a scripted model. */
async function shown(turns = greeterTurns): Promise<ShownAnswer> {
  const h = createAppHarness({ workspace_id: "fictional", data: fictionalData(), skills, session: new HarnessSession(), loop: "pi", step: scripted(turns).model });
  const turn = await askOzzie(h, turns === draftTurns ? "Draft a note to someone who could cover Greeter" : "Who could cover Greeter?", { skills, sender: "Pat" });
  if (turn.state !== "answered") throw new Error(turn.state);
  return turn.answer;
}
const body = (turn: Turn) => renderToStaticMarkup(React.createElement(TurnBody, { turn, onOpen: () => {} }));

describe("Ask Ozzie panel", () => {
  it("explains plainly when nothing is checked and no AI model is set up, and can still be asked what Ozzie can do (owner: useful before accounts are connected)", async () => {
    const html = panel({ brief: null, modelReady: false });
    expect(html).toContain("Nothing has been checked yet.");
    expect(text(html)).toContain("Connect Planning Center in Settings");
    expect(text(html)).toContain("Ask Ozzie needs AI, but everything else in Ozzie works without it.");
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain(note);
    // The one suggestion before anything is checked: what Ozzie can do, answered here.
    expect([...html.matchAll(/class="chip"[^>]*>([^<]*)</gu)].map(m => m[1])).toEqual(["What can you do?"]);
    const { invoke } = await import("@tauri-apps/api/core");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("works from the fictional example, labelled fictional, with suggested questions that fit what was read", () => {
    const html = panel();
    expect(html).toContain("Fictional example. Answers use invented data.");
    expect(html).toContain("Based on: fictional example data as of");
    expect(html).toContain("Who could cover Greeter?");
    expect(html).toContain("Draft a note to someone who could cover Greeter");
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain(note);
    // Without an AI model it can still be asked what Ozzie can do.
    expect(panel({ modelReady: false })).not.toMatch(/<textarea[^>]*disabled=""/);
    // Until Ozzie's procedures are loaded, with nothing else to take a question, there is nothing to run questions through.
    expect(panel({ ask: null })).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("offers Cancel while a question is running", () => {
    const running = panel({ initialTurns: [{ id: 1, question: "Who could cover Greeter?", state: "asking" }] });
    expect(running).toMatch(/<button type="button"[^>]*>Cancel this question<\/button>/);
    expect(running).toContain("Reading what Ozzie already has");
    // The box takes nothing while it runs, but stays focusable so the keyboard isn't dropped (accessibility audit S3a):
    // marked unavailable and read-only, never disabled.
    expect(running).toMatch(/<textarea[^>]*aria-disabled="true" readOnly=""/);
    expect(running).not.toMatch(/<textarea[^>]*\sdisabled=""/);
    expect(panel()).not.toContain("Cancel this question");
  });

  it("shows a verified answer with names restored on this Mac and where it came from", async () => {
    const answer = await shown();
    const html = renderToStaticMarkup(React.createElement(Answer, { answer, onOpen: () => {} }));
    expect(text(html)).toContain("Riley Thornbury has no overlap found for Greeter.");
    expect(html).toContain("Based on: fictional example data as of");
    expect(html).toContain("See how this works");
    expect(html).toContain(">Open Services<");
    expect(html).not.toMatch(/\[(?:Person|Role) \d+\]|Approve|>\s*Send/u);
  });

  it("shows a drafted note as Draft only, with Copy and no way to send", async () => {
    const answer = await shown(draftTurns);
    const html = renderToStaticMarkup(React.createElement(Answer, { answer, onOpen: () => {} }));
    expect(html).toContain("Draft only. Nothing has been sent.");
    expect(html).toContain("Copy draft");
    expect(text(html)).toContain("Hi Riley,");
    expect(text(html)).toContain("Thank you, Pat");
    expect(html).not.toMatch(/\[(?:Person|Role) \d+\]|Approve|>\s*Send/u);
  });

  it("explains how it got there: the procedure word for word, and each step in plain words", async () => {
    const answer = await shown();
    const html = renderToStaticMarkup(React.createElement(HowItWorks, { answer }));
    const t = text(html);
    expect(t).toContain("Ozzie followed this procedure: Answer from what was read");
    expect(html).toContain(skills.get("answer-from-what-was-read")!.body.split("\n")[0]!.replaceAll("'", "&#x27;").replaceAll("\"", "&quot;"));
    // The same short account What happened gives (audit items 7 and 8).
    expect(t).toContain("You asked a question.");
    expect(t).toContain("What Ozzie looked at Looked at who is on the team for an open role — all of it");
    expect(t).toContain("Ozzie asked the AI twice. The AI answered with a list of facts, which Ozzie checked against what it had read before writing anything.");
    expect(t).toContain("Answered.");
    expect(t).toContain("The names Ozzie read from Planning Center, and its roles and rooms, reached the AI only as labels");
    expect(t).toContain("Ozzie put them back on this Mac");
    expect(t).toContain("nothing in Planning Center changed");
    expect(t.replace(answer.procedure!.body.replace(/\s+/g, " "), "")).not.toMatch(HIDDEN_WORDS);
  });

  it("marks an answer that couldn't be fully backed as Worth a look, with what was missing", () => {
    const answer: ShownAnswer = { body: "I can't tell from what I read.", draft: null, notCovered: true, basedOn: "Based on: Planning Center Services, checked Fri", gaps: ["Planning Center Services: part of this couldn't be read."],
      procedure: null, steps: [], aiSteps: 1, page: "sunday" };
    const t = text(renderToStaticMarkup(React.createElement(Answer, { answer, onOpen: () => {} })));
    expect(t).toContain("Worth a look");
    expect(t).toContain("Planning Center Services: part of this couldn't be read.");
  });

  it("says plainly why a question wasn't answered", () => {
    expect(text(body({ id: 1, question: "q", state: "refused", text: REFUSALS.contact }))).toContain("Nothing was sent.");
    expect(text(body({ id: 1, question: "q", state: "no-model" }))).toContain("Ask Ozzie needs AI, but everything else in Ozzie works without it.");
    for (const t of [ASK_FAILURES.egress, ASK_FAILURES.fidelity, ASK_FAILURES.unfinished]) {
      expect(body({ id: 1, question: "q", state: "problem", code: null, text: t })).toMatch(/role="alert"/);
    }
    expect(text(body({ id: 1, question: "q", state: "cancelled", text: ASK_FAILURES.cancelled }))).toContain("You stopped this question.");
  });

  it("with no AI, is never a dead end: one sentence, and one button to How should Ozzie use AI? (walk-through, 2026-11-18)", () => {
    const opened: string[] = [];
    const withWay = (el: React.ReactElement) => renderToStaticMarkup(React.createElement(ChooseAiContext.Provider, { value: () => { opened.push("ai"); } }, el));
    expect(NEEDS_AI.ask).toBe("Ask Ozzie needs AI, but everything else in Ozzie works without it.");
    expect(NEEDS_AI.button).toBe("Choose how Ozzie uses AI");
    // On top of the panel, on any page, Settings included (it no longer says "Set one up in AI help on this page").
    for (const page of ["today", "sunday", "connection"]) {
      const html = withWay(React.createElement(AskPanel, { open: true, onClose: () => {}, ask: never, brief: fictional, modelReady: false, onOpen: () => {}, page }));
      expect(text(html)).toContain(NEEDS_AI.ask);
      expect(html).toContain(`>${NEEDS_AI.button}</button>`);
      expect(html).not.toMatch(/AI model|Set one up|isn&#x27;t set up/u);
    }
    // A question asked anyway: its card says the same, badged "Needs AI", with the same one step, and VoiceOver hears it.
    const card = withWay(React.createElement(AskCard, { turn: { id: 1, question: "Who could cover Greeter?", state: "no-model" }, onOpen: () => {} }));
    expect(card).toContain(">Needs AI</span>");
    expect(text(card)).toContain(NEEDS_AI.ask);
    expect(card).toContain(`>${NEEDS_AI.button}</button>`);
    expect(turnAnnouncement({ id: 1, question: "q", state: "no-model" })).toBe(NEEDS_AI.ask);
    // Where nothing opens the AI screens (a page drawn alone), no button promises it.
    expect(body({ id: 1, question: "q", state: "no-model" })).not.toContain(NEEDS_AI.button);
    expect(opened).toEqual([]);
  });

  it("tells VoiceOver one short status per turn instead of reading the whole thread again", async () => {
    const answer = await shown();
    expect(turnAnnouncement(undefined)).toBe("");
    expect(turnAnnouncement({ id: 1, question: "q", state: "asking" })).toBe("Reading what Ozzie already has…");
    expect(turnAnnouncement({ id: 1, question: "q", state: "cancelled", text: ASK_FAILURES.cancelled })).toBe(ASK_FAILURES.cancelled);
    const said = turnAnnouncement({ id: 1, question: "Who could cover Greeter?", state: "answered", answer });
    expect(said).toBe(`Ozzie answered: ${answer.body.split(/\n{2,}/u)[0]}`);
    expect(said).not.toContain(answer.procedure!.body.slice(0, 40));
    const unsure: ShownAnswer = { ...answer, notCovered: true, draft: "Hi Riley" };
    expect(turnAnnouncement({ id: 1, question: "q", state: "answered", answer: unsure })).toMatch(/Worth a look\. A draft note is below\.$/u);
    // An answer that opens with a group's label line is said with the line it heads, never as the bare label (review of the
    // 0.3.2 wording change).
    const grouped: ShownAnswer = { ...answer, body: "Needs a decision:\n\nGreeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.\n\nNursery at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count." };
    expect(turnAnnouncement({ id: 1, question: "q", state: "answered", answer: grouped }))
      .toBe("Ozzie answered: Needs a decision: Greeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.");
    // On screen, the label line reads as the heading of its group.
    const lines = renderToStaticMarkup(React.createElement(Answer, { answer: grouped, onOpen: () => {} }));
    expect(lines).toContain('<div class="ask-lines"><p class="ask-group">Needs a decision:</p><p>Greeter at 9:30 AM');
    expect(readFileSync(new URL("../src/ask-panel.css", import.meta.url), "utf8")).toMatch(/\.oz \.ask-lines p\.ask-group \{[^}]*font-weight: 600;/u);
    // The thread itself is no longer a live region; only the status line is.
    const html = panel({ initialTurns: [{ id: 1, question: "Who could cover Greeter?", state: "answered", answer }] });
    expect(html).not.toMatch(/class="thread ask-thread"[^>]*aria-live/u);
    expect(html).toContain(`<p class="sr-only" role="status" aria-live="polite">Ozzie answered: `);
  });

  it("no longer uses the old fact-sheet route", () => {
    const source = readFileSync(new URL("../src/ask-panel.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/prepareAsk|acceptAskReply|buildAskContext|restoreAnswer|model\.ask|ask_ozzie/u);
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).not.toMatch(/AskSession|model\.ask/u);
    // One harness path (audit item 11): the native command is gone, and nothing in the app or its debug autopilot asks for it.
    for (const file of ["../src/model.ts", "../src/autopilot.ts", "../src-tauri/src/main.rs"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toMatch(/ask_ozzie|AskRequest|AskModelRequest|acceptAskReply/u);
    }
  });

  it("is reachable from every screen through the sidebar once a first result is seen, and closed until the leader opens it, at any width (audit item 8, review M11)", () => {
    // Before the first result (a fresh Mac), Ask waits so nothing pulls a person off setup's one step (review M11).
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).not.toMatch(/<button[^>]*aria-controls="ask-panel"/);
    expect(html).toMatch(/<aside id="ask-panel"[^>]*hidden=""/);
    expect(html).toContain("shell shell-2");
    // Once a result is seen, the sidebar's button opens it, from every page.
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/\{askShown && <button type="button" ref=\{askEntry\} className="btn btn-secondary ask-entry" aria-expanded=\{askOpen\} aria-controls="ask-panel"/u);
    // On B1 Church or Breeze, a result of its own check (decision 21).
    // Genesis's own first result counts as seen (review of e9cbd97d, M6).
    expect(app).toContain("const resultSeen = onSystem ? Boolean(sys.connection?.result_seen) || Boolean(sys.built)\n    : onGenesis ? Boolean(sys.state.genesis?.result_seen) || Boolean(genesis.capture) : recordings.length > 0 || Boolean(ofWatched);");
    // A church that leaves setup without a result can still reach Ask (re-check Low).
    expect(app).toContain('const askShown = resultSeen || setup === null;');
    // Never docked open by a wide window: it opens only on the leader's click, and stays as they left it.
    expect(app).toMatch(/const \[askOpen, setAskOpen\] = useState\(false\);/u);
    expect(app).not.toMatch(/min-width: 1440px/u);
  });

  it("shows an answer as a card like a finding, not a chat thread: the question, Ozzie's sentences, sources, See how this works", async () => {
    const answer = await shown();
    const html = panel({ initialTurns: [{ id: 1, question: "Who could cover Greeter?", state: "answered", answer }] });
    expect(html).toMatch(/<article class="find ask-card" aria-labelledby="ask-q-1"><div class="find-top"><span class="badge b-ok">Answered<\/span><span class="find-where">Ask Ozzie<\/span><\/div><h3 id="ask-q-1" class="find-title ask-q">Who could cover Greeter\?<\/h3>/u);
    expect(text(html)).toMatch(/Riley Thornbury has no overlap found for Greeter\. .*Based on: fictional example data as of .* Open Services See how this works/u);
    expect(html).not.toMatch(/msg-me|msg-oz|class="thread/u);
    // Suggested questions wrap rather than scroll off the panel's edge.
    expect(html).not.toContain("is-compact");
  });

  it("folds the two notes about Ask away once there is an answer, so the answer stays in view", async () => {
    const before = panel();
    expect(text(before)).toContain(ASK_INTRO);
    expect(before).toContain(note);
    expect(before).not.toContain(ASK_ABOUT);
    const answer = await shown();
    const after = panel({ initialTurns: [{ id: 1, question: "Who could cover Greeter?", state: "answered", answer }] });
    const folded = /<details class="listen-more ask-about">([\s\S]*?)<\/details>/u.exec(after)?.[1] ?? "";
    expect(folded).toContain(ASK_ABOUT);
    expect(folded).toContain(note);
    expect(text(folded)).toContain(ASK_INTRO);
    // Nowhere else: the answer comes first.
    expect(after.replace(/<details class="listen-more ask-about">[\s\S]*?<\/details>/u, "")).not.toContain(note);
    expect(after.indexOf("ask-card")).toBeLessThan(after.indexOf("ask-about"));
  });

  it("folds what speaking does away with the notes once there is an answer; listening still shows on the line", async () => {
    const hint = "Speak instead of typing (⌘⇧L). Your words become text on this Mac. No audio is kept or sent.";
    const line = (html: string) => /<p class="small ask-voice" id="ask-voice-line"[^>]*>([^<]*)<\/p>/u.exec(html)?.[1] ?? "";
    expect(line(panel({ initialVoice: { status: "ready" } }))).toBe(hint);
    const answer = await shown();
    const after = panel({ initialVoice: { status: "ready" }, initialTurns: [{ id: 1, question: "Who could cover Greeter?", state: "answered", answer }] });
    expect(line(after)).toBe("");
    expect(/<details class="listen-more ask-about">[\s\S]*?<\/details>/u.exec(after)?.[0]).toContain(hint);
    // Why speaking is off folds the same way.
    const off = panel({ initialVoice: { status: "not-available" }, initialTurns: [{ id: 1, question: "Who could cover Greeter?", state: "answered", answer }] });
    expect(line(off)).toBe("");
    expect(text(off)).toContain("This Mac can't turn speech into text on its own");
  });

  it("uses the app's type scale: nothing in Ask below 14px, its secondary lines at the small size", () => {
    const css = readFileSync(new URL("../src/ask-panel.css", import.meta.url), "utf8") + readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const askRules = css.split("\n").filter(l => /\.ask-|\.ai-look|\.writeup|\.task-account|procedure-body/u.test(l));
    expect(askRules.length).toBeGreaterThan(20);
    for (const rule of askRules) for (const m of rule.matchAll(/font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/gu)) expect(Number(m[1]), rule).toBeGreaterThanOrEqual(14);
    expect(css).toMatch(/\.oz \.ask-based \{[^}]*font-size: var\(--t-sm\)/u);
    expect(css).toMatch(/\.oz \.ask-links \.src \{[^}]*font-size: var\(--t-sm\)/u);
  });

  it("names itself on two lines that never wrap mid-phrase: Ask Ozzie, then quieter, what it answers (owner's read of 0.3.2)", () => {
    const html = panel();
    expect(html).toContain('<div class="ask-head"><span class="ask-head-title">Ask Ozzie</span><span class="ask-head-scope">Questions about your services</span></div>');
    expect(text(html)).not.toMatch(/\(questions about/iu);
    const css = readFileSync(new URL("../src/ask-panel.css", import.meta.url), "utf8");
    // Stacked in the 56px header; each line one line at 360–420px (an ellipsis only if a panel were narrower still).
    expect(css).toMatch(/\.oz \.ask-panel \.ask-head \{[^}]*flex-direction: column;[^}]*min-width: 0;/u);
    expect(css).toMatch(/\.oz \.ask-panel \.ask-head > span \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/u);
    expect(css).toMatch(/\.oz \.ask-panel \.ask-head-scope \{[^}]*font-size: var\(--t-sm\);[^}]*color: var\(--ink-3\);/u);
  });

  it("keeps earlier questions this session as a short list to reopen, newest first, with the newest card on show", async () => {
    const answer = await shown();
    const turns: Turn[] = [
      { id: 1, question: "Who could cover Greeter?", state: "answered", answer },
      { id: 2, question: "What can you do?", state: "help", checked: true },
      { id: 3, question: "Read these visitor cards", state: "cards" },
    ];
    const html = panel({ initialTurns: turns });
    expect(html.match(/<article class="find ask-card"/gu)).toHaveLength(1);
    expect(html).toContain('<h3 id="ask-q-3" class="find-title ask-q">Read these visitor cards</h3>');
    const earlier = /<section class="ask-earlier"[\s\S]*?<\/section>/u.exec(html)?.[0] ?? "";
    expect(text(earlier)).toBe(" Earlier questions What can you do? Who could cover Greeter? ");
    expect(earlier.match(/<button type="button" class="btn btn-quiet btn-sm ask-reopen">/gu)).toHaveLength(2);
    // A long session lists only the newest few.
    const many = Array.from({ length: EARLIER_SHOWN + 4 }, (_, i): Turn => ({ id: i + 1, question: `Question ${i + 1}`, state: "help", checked: true }));
    expect(panel({ initialTurns: many }).match(/ask-reopen/gu)).toHaveLength(EARLIER_SHOWN);
  });

  it("calls a saved copy of a check what it is, never a recording", () => {
    const html = text(panel({ brief: { ...fictional, mode: "recording" } }));
    expect(html).toMatch(/A saved copy of a check from .+\. Not a current check\./u);
    expect(html).not.toMatch(/recording/iu);
  });

  it("uses none of the words people shouldn't see", async () => {
    const answer = await shown();
    const all = [panel(), panel({ brief: null, modelReady: false }), panel({ initialTurns: [{ id: 1, question: "Who could cover Greeter?", state: "answered", answer }] }),
      panel({ initialVoice: { status: "ready" } }), panel({ initialVoice: { status: "no-permission", what: "speech" } })];
    for (const html of all) expect(text(html)).not.toMatch(HIDDEN_WORDS);
  });
});

describe("speaking a question in Ask", () => {
  const mic = (html: string) => /<button type="button" class="ibtn ask-mic[^"]*"[^>]*>/.exec(html)?.[0] ?? "";

  it("offers a labelled microphone button with a keyboard shortcut and a one-line privacy hint", () => {
    const html = panel({ initialVoice: { status: "ready" } });
    const button = mic(html);
    expect(button).toContain('aria-label="Speak your question"');
    expect(button).toContain('aria-keyshortcuts="Meta+Shift+L"');
    expect(button).toContain('aria-describedby="ask-voice-line"');
    expect(button).not.toContain("disabled");
    expect(html).toContain("Speak instead of typing (⌘⇧L). Your words become text on this Mac. No audio is kept or sent.");
    // The words go into the box for the person; the Ask button stays theirs to press.
    expect(html).toMatch(/<button type="submit" class="btn btn-primary btn-sm" disabled="">Ask<\/button>/);
  });

  it("stays off and says why when this Mac can't listen or Ozzie isn't allowed to", () => {
    const unavailable = panel({ initialVoice: { status: "not-available" } });
    expect(mic(unavailable)).toContain('disabled=""');
    expect(unavailable).toContain("This Mac can&#x27;t turn speech into text on its own, so speaking a question is off. Type your question instead.");
    expect(unavailable).not.toContain("No audio is kept or sent");
    const refused = panel({ initialVoice: { status: "no-permission", what: "microphone" } });
    expect(mic(refused)).toContain('disabled=""');
    expect(refused).toContain("System Settings › Privacy &amp; Security › Microphone");
    // Before the check the button is off; with nothing checked yet a question can still be spoken (what Ozzie can do).
    expect(mic(panel())).toContain('disabled=""');
    expect(mic(panel({ initialVoice: { status: "ready" }, brief: null, modelReady: false }))).not.toContain('disabled=""');
  });

  it("points visitor-card requests to the Visitor cards page without asking any AI model", () => {
    for (const typed of ["Read these visitor cards", "Can you enter the newcomer cards from Sunday?", "guest card", "Scan our connection cards"]) {
      expect(isCardsRequest(typed)).toBe(true);
    }
    for (const typed of ["Who could cover Greeter?", "Draft a note about the card table", "Discover cards"]) {
      expect(isCardsRequest(typed)).toBe(false);
    }
    const turn: Turn = { id: 1, question: "Read these visitor cards", state: "cards" };
    const html = body(turn);
    expect(html).toContain("Visitor cards are read on this Mac, on the Visitor cards page");
    expect(html).toContain("Nothing from them goes to an AI model or is added to Planning Center.");
    expect(html).toContain(">Open Visitor cards<");
    // Already on that page: no button to where the person already is.
    expect(renderToStaticMarkup(React.createElement(TurnBody, { turn, page: "cards", onOpen: () => {} }))).not.toContain("Open Visitor cards");
    expect(panel({ initialTurns: [turn] })).toContain("Visitor cards are read on this Mac");
  });

  it("checks nothing natively until the panel is on screen", async () => {
    panel({ initialVoice: { status: "ready" } });
    const { invoke } = await import("@tauri-apps/api/core");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("Ask before anything is connected, and what Ozzie can do (owner decisions, Nov 15)", () => {
  it("knows a help question from a question that mentions help", () => {
    for (const q of ["What can you do?", "help", "Help!", "How do you work?", "what do you do", "Ozzie, what can you do?", "What can I ask?", "How can you help me?"]) {
      expect(isHelpRequest(q), q).toBe(true);
    }
    for (const q of ["Who could help with Greeter?", "Help me find someone for the nursery", "What do you do when someone declines?", "Can you help cover Greeter?"]) {
      expect(isHelpRequest(q), q).toBe(false);
    }
  });

  it("answers help, cards and plans without any AI; before anything is checked it says what to do next", () => {
    const plan = { kind: "plan" } as unknown as Exclude<Parsed, { kind: "none" }>;
    const parse = (t: string): Parsed => /keep an eye/iu.test(t) ? plan : { kind: "none" } as Parsed;
    const none = { brief: null, modelReady: false, canAsk: false, parse };
    expect(routeQuestion("What can you do?", none)).toEqual({ kind: "help" });
    expect(routeQuestion("Read these visitor cards", none)).toEqual({ kind: "cards" });
    expect(routeQuestion("Keep an eye on Sunday", none)).toEqual({ kind: "plan", parsed: plan });
    expect(routeQuestion("Is the nursery ready?", { ...none, modelReady: true, canAsk: true })).toEqual({ kind: "start" });
    expect(routeQuestion("Is the nursery ready?", { ...none, brief: fictional })).toEqual({ kind: "no-model" });
    // Kids teams and background checks are answered on this Mac, so they need no AI model.
    expect(routeQuestion("Is the nursery ready?", { ...none, brief: fictional, canAsk: true })).toEqual({ kind: "ask" });
    expect(routeQuestion("Who could cover Greeter?", { ...none, brief: fictional, canAsk: true })).toEqual({ kind: "no-model" });
    expect(routeQuestion("Has Blake been screened?", { ...none, brief: fictional, canAsk: true })).toEqual({ kind: "ask" });
    expect(routeQuestion("Is the nursery ready?", { ...none, brief: fictional, modelReady: true })).toEqual({ kind: "loading" });
    expect(routeQuestion("Is the nursery ready?", { ...none, brief: fictional, modelReady: true, canAsk: true })).toEqual({ kind: "ask" });
  });

  it("lists what Ozzie can do here and what it never does, with nothing sent", () => {
    const t = text(body({ id: 1, question: "What can you do?", state: "help", checked: true }));
    for (const s of ["Check the service Ozzie watches", "who on a team could help", "Prepare a note", "copy", "Keep an eye on the service", "room bookings", "follow-ups", "group meetings",
      "morning briefing", "visitor cards", "never sends messages", "never changes Planning Center unless you confirm that one change", "prayers", "sermons", "Nothing was sent."]) expect(t, s).toContain(s);
    expect(t).not.toMatch(HIDDEN_WORDS);
    // Before anything is checked: what to do first, and the way there.
    const first = body({ id: 1, question: "help", state: "help", checked: false });
    expect(text(first)).toContain("connect Planning Center in Settings");
    expect(first).toContain(">Open Settings</button>");
    expect(turnAnnouncement({ id: 1, question: "help", state: "help", checked: true })).toBe("Ozzie listed what it can do here. Nothing was sent.");
  });

  it("answers a question before anything is checked with what to do next, never an error", () => {
    const html = body({ id: 1, question: "Is the nursery ready?", state: "start" });
    expect(text(html)).toContain(ASK_START);
    expect(text(html)).toContain("Nothing was sent.");
    expect(html).toContain(">Open Settings</button>");
    expect(html).toContain(">Open Services</button>");
    expect(html).not.toMatch(/role="alert"/u);
    expect(text(html)).not.toMatch(HIDDEN_WORDS);
  });

  it("refuses sermons, prayers and scripture here, saying nothing was sent", () => {
    expect(text(body({ id: 1, question: "Write a sermon", state: "refused", text: REFUSALS.religious }))).toContain("Nothing was sent.");
  });

  it("marks an answer written on this Mac: nothing was sent, where it came from, and how it was made", () => {
    const answer: ShownAnswer = { body: "Needs a decision: Blake Ashgrove has no current background check on file.", draft: null, notCovered: false,
      basedOn: "Based on: Planning Center Services, checked Fri", gaps: [], procedure: null, steps: ["Looked at background checks, kept on this Mac"], aiSteps: 0, page: "sunday", local: true };
    const html = text(renderToStaticMarkup(React.createElement(Answer, { answer, onOpen: () => {} })));
    expect(html).toContain("Answered on this Mac without the AI. Nothing was sent.");
    expect(html).toContain("Based on: Planning Center Services, checked Fri");
    const how = text(renderToStaticMarkup(React.createElement(HowItWorks, { answer })));
    expect(how).toContain("Ozzie answered this on this Mac from its last check, without asking the AI.");
    expect(how).toContain("Looked at background checks, kept on this Mac");
    expect(how).not.toContain("Ozzie asked the AI");
    expect(how).not.toMatch(HIDDEN_WORDS);
  });

  it("marks an answer Ozzie wrote itself after the AI's listed more than 24 facts: never the AI's choice, never without the AI", () => {
    const answer: ShownAnswer = { body: "For Sunday, November 22, this check found 24 items that need a decision and 2 worth a look.\n\nOn the Sunday page, needing a decision:",
      draft: null, notCovered: false, basedOn: "Based on: fictional example data", gaps: [], procedure: null,
      steps: ["Looked at the overview of the last check — all of it"], aiSteps: 2, page: "sunday", composedHere: true };
    const html = text(renderToStaticMarkup(React.createElement(Answer, { answer, onOpen: () => {} })));
    // It covers the whole service, whatever the question named (review L6: "What still needs a decision about Riley?").
    expect(html).toContain("Ozzie wrote this answer itself from what it read, and it covers the whole service. The AI's answer listed more than 24 facts, more than Ozzie checks in one answer, so it isn't shown.");
    expect(html).not.toContain("Answered on this Mac without the AI");
    const how = text(renderToStaticMarkup(React.createElement(HowItWorks, { answer })));
    expect(how).toContain("Ozzie asked the AI twice.");
    expect(how).toContain("The AI's answer listed more than 24 facts, so Ozzie wrote this answer itself from what it read.");
    expect(how).toContain("so Ozzie set it aside and wrote this answer itself on this Mac from the same check: its counts, then each open decision in the order the Services page shows them.");
    // Never what an answer from the AI's own choice says.
    expect(how).not.toContain("The AI only chose which facts answer your question");
    expect(how).not.toContain("The AI answered with a list of facts");
    expect(how).not.toMatch(HIDDEN_WORDS);
    // A Wednesday service names its own page.
    const wed = text(renderToStaticMarkup(React.createElement(DayProvider, { value: wednesdayWords() }, React.createElement(HowItWorks, { answer }))));
    expect(wed).toContain("in the order the Services page shows them.");
  });
});

afterAll(() => {
  // No question this file asked through a model carried background-check wording (review Q H2).
  expect(everyRequest.length).toBeGreaterThan(0);
  for (const r of everyRequest) expect(JSON.stringify(r)).not.toMatch(BACKGROUND_IN_REQUEST);
});

// Onboarding spec §5 and §6 (decision 18): the panel names the watched service by its own day, never "Sunday".
describe("Ask Ozzie for a Wednesday service", () => {
  const wed = wednesdayCapture();
  const brief = buildSundayBrief(wed, rules, wed.completed_at, true);
  const inWednesday = (node: React.ReactElement) => renderToStaticMarkup(React.createElement(DayProvider, { value: wednesdayWords() }, node));
  const wedPanel = (over: Partial<React.ComponentProps<typeof AskPanel>> = {}) => inWednesday(React.createElement(AskPanel, {
    open: true, onClose: () => {}, ask: never, brief, modelReady: true, onOpen: () => {}, ...over,
  }));

  it("asks about this Wednesday, says what Ask is for, and suggests Wednesday's questions", () => {
    const html = wedPanel();
    expect(html).toContain('placeholder="Ask about your services…"');
    // Its name, then under it, quieter, what it answers: one line each, no parentheses (owner's read of 0.3.2).
    expect(html).toMatch(/<div class="convo-head"><svg[^>]*>.*?<\/svg><div class="ask-head"><span class="ask-head-title">Ask Ozzie<\/span><span class="ask-head-scope">Questions about your services<\/span><\/div><span class="spacer"><\/span>/u);
    expect(text(html)).not.toMatch(/\(questions about/iu);
    expect(text(html)).toContain("What still needs a decision this Wednesday?");
    expect(text(html)).not.toMatch(/sunday/iu);
  });

  it("before anything is checked, points to the Services page and opens it by name", () => {
    const html = wedPanel({ brief: null, page: "today" });
    expect(text(html)).toContain("check Planning Center on the Services page.");
    expect(html).toContain(">Open Services</button>");
    expect(text(html)).not.toMatch(/sunday/iu);
  });

  it("a refusal that points to the Sunday page points to the Services page instead", () => {
    const html = inWednesday(React.createElement(TurnBody, { turn: { id: 1, question: "q", state: "refused", text: REFUSALS.background } as Turn, onOpen: () => {} }));
    expect(text(html)).toContain("look at the Services page.");
    expect(text(html)).not.toMatch(/sunday/iu);
  });
});

describe("Ask with nothing checked says what is true of the connection (0.3.0 live: no 'Connect' to a set-up church)", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ");
  it("offers Connect only when Planning Center isn't connected; says it is checking while the launch check runs", () => {
    expect(text(panel({ brief: null }))).toContain("Nothing has been checked yet. Connect Planning Center in Settings");
    const checking = text(panel({ brief: null, connection: "checking" }));
    expect(checking).toContain("Nothing has been checked yet. Ozzie is checking Planning Center now.");
    expect(checking).not.toContain("Connect Planning Center");
    const connected = text(panel({ brief: null, connection: "connected" }));
    expect(connected).toContain("Nothing has been checked yet. Check Planning Center on");
    expect(connected).not.toContain("Connect Planning Center");
  });
});

