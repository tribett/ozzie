import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { REFUSALS } from "../../../core/src/ask.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { Answer, ASK_NOTE, AskPanel, HowItWorks, TurnBody, type Turn } from "../src/ask-panel.js";
import { App } from "../src/App.js";
import { askOzzie, createAppHarness, type AskTurn, type ShownAnswer } from "../src/harness-bridge.js";
import { ASK_FAILURES } from "../src/harness-words.js";
import { draftTurns, fictionalData, greeterTurns, HIDDEN_WORDS, scripted, text } from "./harness-fakes.js";

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
  it("is disabled with plain explanations when nothing is checked and no AI model is set up", async () => {
    const html = panel({ brief: null, modelReady: false });
    expect(html).toContain("Nothing has been checked yet.");
    expect(html).toContain("Ask Ozzie needs an AI model. Set one up under Settings.");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain(note);
    expect(html).not.toContain("class=\"chip\"");
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
    expect(panel({ modelReady: false })).toMatch(/<textarea[^>]*disabled=""/);
    // Until Ozzie's procedures are loaded there is nothing to run questions through.
    expect(panel({ ask: null })).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("offers Cancel while a question is running", () => {
    const running = panel({ initialTurns: [{ id: 1, question: "Who could cover Greeter?", state: "asking" }] });
    expect(running).toMatch(/<button type="button"[^>]*>Cancel this question<\/button>/);
    expect(running).toContain("Reading what Ozzie already has");
    expect(running).toMatch(/<textarea[^>]*disabled=""/);
    expect(panel()).not.toContain("Cancel this question");
  });

  it("shows a verified answer with names restored on this Mac and where it came from", async () => {
    const answer = await shown();
    const html = renderToStaticMarkup(React.createElement(Answer, { answer, onOpen: () => {} }));
    expect(text(html)).toContain("Riley Thornbury has no overlap found for Greeter.");
    expect(html).toContain("Based on: fictional example data as of");
    expect(html).toContain("See how this works");
    expect(html).toContain(">Open Sunday<");
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
    expect(t).toContain("Looked at who on the team could help — complete");
    expect(t).toContain("Checked the facts it chose against what was read");
    expect(t).toContain("Ozzie asked the AI 2 times.");
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
    expect(text(body({ id: 1, question: "q", state: "no-model" }))).toContain("Ask Ozzie needs an AI model. Set one up under Settings.");
    expect(body({ id: 1, question: "q", state: "no-model" })).toContain(">Open Settings</button>");
    for (const t of [ASK_FAILURES.egress, ASK_FAILURES.fidelity, ASK_FAILURES.unfinished]) {
      expect(body({ id: 1, question: "q", state: "problem", code: null, text: t })).toMatch(/role="alert"/);
    }
    expect(text(body({ id: 1, question: "q", state: "cancelled", text: ASK_FAILURES.cancelled }))).toContain("You stopped this question.");
  });

  it("no longer uses the old fact-sheet route", () => {
    const source = readFileSync(new URL("../src/ask-panel.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/prepareAsk|acceptAskReply|buildAskContext|restoreAnswer|model\.ask|ask_ozzie/u);
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).not.toMatch(/AskSession|model\.ask/u);
  });

  it("is reachable from every screen through the sidebar, closed by default on a narrow window", () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toMatch(/<button[^>]*aria-controls="ask-panel"[^>]*>.*Ask Ozzie<\/button>/);
    expect(html).toMatch(/<aside id="ask-panel"[^>]*hidden=""/);
    expect(html).toContain("shell shell-2");
  });

  it("uses none of the words people shouldn't see", async () => {
    const answer = await shown();
    const all = [panel(), panel({ brief: null, modelReady: false }), panel({ initialTurns: [{ id: 1, question: "Who could cover Greeter?", state: "answered", answer }] })];
    for (const html of all) expect(text(html)).not.toMatch(HIDDEN_WORDS);
  });
});
