import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { acceptAskReply, AskSession, buildAskContext, prepareAsk, REFUSALS, restoreAnswer } from "../../../core/src/ask.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { Answer, ASK_NOTE, askFailure, AskPanel } from "../src/ask-panel.js";
import { App } from "../src/App.js";

const capture = nov22Capture();
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const fictional = buildSundayBrief(capture, rules, capture.completed_at, true);
const panel = (over: Partial<React.ComponentProps<typeof AskPanel>> = {}) => renderToStaticMarkup(React.createElement(AskPanel, {
  open: true, onClose: () => {}, session: new AskSession(), brief: fictional, names: capture.names, organization: capture.organization,
  decisions: [], modelReady: true, sender: "", onOpen: () => {}, ...over,
}));
const note = ASK_NOTE.replace("'", "&#x27;");

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

  it("answers from the fictional example, labelled fictional, with chips that fit what was read", () => {
    const html = panel();
    expect(html).toContain("Fictional example. Answers use invented data.");
    expect(html).toContain("Based on: fictional example data as of");
    expect(html).toContain("Who could cover Greeter?");
    expect(html).toContain("Draft a note to the Nursery team leader");
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain(note);
    // Names may appear on this screen, but nowhere is a name joined to a request.
    expect(panel({ modelReady: false })).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("shows a drafted note as Draft only, with Copy and no way to send", () => {
    const session = new AskSession();
    const context = buildAskContext(session, { brief: fictional, names: capture.names, organization: capture.organization })!;
    const prepared = prepareAsk(session, context, "Draft a note to the Nursery team leader");
    if (!prepared.ok) throw new Error(prepared.refusal);
    const reply = "I can't tell from what I read. The facts list one Nursery team leader.\nDraft note:\nHi [Person 8], Nursery still needs one more person this Sunday. Do you know who we could ask?\n\nThanks,\n[Your name]";
    const answer = restoreAnswer(acceptAskReply(reply, prepared.asked), "Pat");
    const html = renderToStaticMarkup(React.createElement(Answer, { answer, asked: prepared.asked, names: capture.names, onOpen: () => {} }));
    expect(html).toContain("Draft only. Nothing has been sent.");
    expect(html).toContain("Copy draft");
    expect(html).toContain("Hi Jordan, Nursery still needs one more person");
    expect(html).toContain("Worth a look");
    expect(html).toContain("Based on: fictional example data as of");
    expect(html).toContain("See how this works");
    expect(html).not.toMatch(/>\s*Send|Approve|\[Person \d+\]/);
  });

  it("shows the native name check as a plain refusal that suggests rewording, and other failures as problems", () => {
    // ask_ozzie refuses with name-present when the session has seen a name this screen didn't replace.
    const refused = askFailure("name-present");
    expect(refused).toEqual({ state: "refused", text: REFUSALS.native });
    expect(refused.text).toMatch(/Nothing was sent\. Try asking again in other words/);
    expect(refused.text).not.toMatch(/\[Person|name-present|native|guard/i);
    expect(askFailure("rate-limited").state).toBe("problem");
    expect(askFailure(new Error("boom"))).toEqual({ state: "problem", text: "The AI model couldn't be reached. Try again in a minute." });
  });

  it("explains that people and roles travelled only as labels", () => {
    const session = new AskSession();
    const context = buildAskContext(session, { brief: fictional, names: capture.names, organization: capture.organization })!;
    const prepared = prepareAsk(session, context, "Who could cover Greeter?");
    if (!prepared.ok) throw new Error(prepared.refusal);
    expect(prepared.asked.sent).toBe("Who could cover [Role 1]?");
    const answer = restoreAnswer(acceptAskReply("[Person 1] has no overlap found for [Role 1].", prepared.asked), "Pat");
    const html = renderToStaticMarkup(React.createElement(Answer, { answer, asked: prepared.asked, names: capture.names, onOpen: () => {} }));
    expect(html).toContain("Riley Thornbury has no overlap found for Greeter.");
    expect(html).not.toMatch(/\[(?:Person|Role) \d+\]/);
  });

  it("is reachable from every screen through the sidebar, closed by default on a narrow window", () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toMatch(/<button[^>]*aria-controls="ask-panel"[^>]*>.*Ask Ozzie<\/button>/);
    expect(html).toMatch(/<aside id="ask-panel"[^>]*hidden=""/);
    expect(html).toContain("shell shell-2");
  });
});
