// Names VoiceOver can tell apart (accessibility audit M1, M2): "Prepare a note" on each person's row says whose note it
// is, starting with the words on screen (so Voice Control's "Click Prepare a note" still works); and a card's status
// ("Needs a decision", "Worth a look") ends its heading, unseen, so heading navigation doesn't skip it, while the badge
// keeps its place on screen and is hidden from VoiceOver, so the words are said once. Fixed fictional data.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { PREPARE_NOTE, SundayPage } from "../src/sunday-page.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { fictionalOperations } from "../../../core/src/fictional-operations.js";

const capture = nov22Capture();
const brief = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at);
const html = renderToStaticMarkup(React.createElement(SundayPage, {
  brief, names: capture.names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true, canReword: false,
  decisions: [], onDecisions: () => undefined, operations: fictionalOperations(), onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
}));
const unescape = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replaceAll("&amp;", "&");

describe("Prepare a note on each person's row", () => {
  it("says whose note it is, after the words on screen, and no two rows read the same", () => {
    const buttons = [...html.matchAll(/<button type="button" class="btn btn-secondary btn-sm push" aria-expanded="false" aria-label="([^"]+)">([^<]+)<\/button>/gu)]
      .map(m => [unescape(m[1]!), unescape(m[2]!)] as const);
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const [label, shown] of buttons) {
      expect(shown).toBe(PREPARE_NOTE);
      expect(label.startsWith(`${PREPARE_NOTE} to `)).toBe(true);
      expect(Object.values(capture.names)).toContain(label.slice(`${PREPARE_NOTE} to `.length));
    }
    // Two people on the same card, two different names.
    expect(new Set(buttons.map(([label]) => label)).size).toBe(buttons.length);
  });
});

describe("a card's status, in its heading", () => {
  it("every Needs a decision and Worth a look card ends its heading with its status, and its badge is hidden from VoiceOver", () => {
    const cards = html.split("<article").slice(1).map(a => a.slice(0, a.indexOf("</article>")));
    const flagged = cards.filter(c => /<span class="badge b-(?:attn|look)"/u.test(c));
    expect(flagged.length).toBeGreaterThanOrEqual(5);
    for (const card of flagged) {
      const badge = /<div class="find-top"><span class="badge b-(?:attn|look)" aria-hidden="true">(?:<svg[\s\S]*?<\/svg>)?([^<]+)<\/span>/u.exec(card);
      expect(badge, card.slice(0, 160)).not.toBeNull();
      const words = unescape(badge![1]!);
      expect(card).toMatch(new RegExp(`<h3 class="find-title"[^>]*>[^]*?<span class="sr-only"> ${words.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.</span></h3>`, "u"));
    }
    expect(flagged.some(c => c.includes("> Needs a decision.</span></h3>"))).toBe(true);
    expect(flagged.some(c => c.includes("> Worth a look.</span></h3>"))).toBe(true);
  });
});
