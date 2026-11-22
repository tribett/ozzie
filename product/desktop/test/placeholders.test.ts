// Hints inside empty fields (accessibility audit S5): WebKit's pale default was about 1.8:1, so they take the secondary
// text colour, computed here against every surface a field sits on, in light and dark and with Increase contrast; and the
// two hints that carried meaning are help text a person can read beside the field instead (Church rules' scheduled
// leads, and why Ask's box takes nothing yet).
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { LEAD_EMPTY_HELP, RulesPage } from "../src/rules-page.js";
import { ASK_UNAVAILABLE, AskPanel } from "../src/ask-panel.js";

const raw = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
const hearth = raw("hearth.css"), styles = raw("styles.css");
const token = (block: string, name: string) => new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`, "u").exec(block)?.[1] ?? "";
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };

describe("hints in empty fields", () => {
  it("use --ink-3 at full strength, which passes 4.5:1 on the field surface and on paper, light and dark, with and without Increase contrast", () => {
    expect(styles).toMatch(/\.oz ::placeholder \{ color: var\(--ink-3\); opacity: 1; \}/u);
    const light = hearth.slice(hearth.indexOf(".oz{"), hearth.indexOf("}", hearth.indexOf(".oz{")));
    const darkAt = hearth.indexOf(".oz.dark,.oz .dark{");
    const dark = hearth.slice(darkAt, hearth.indexOf("}", darkAt));
    const more = styles.slice(styles.indexOf("@media (prefers-contrast: more) {"));
    const moreLight = more.slice(0, more.indexOf(".oz.dark")), moreDark = more.slice(more.indexOf(".oz.dark"));
    // Fields are drawn on --surface (inputs, .input) or --paper (Ask's box, a note being changed).
    const pairs: [string, string, string][] = [
      ["light", token(light, "ink-3"), token(light, "surface")], ["light", token(light, "ink-3"), token(light, "paper")],
      ["dark", token(dark, "ink-3"), token(dark, "surface")], ["dark", token(dark, "ink-3"), token(dark, "paper")],
      ["light, Increase contrast", token(moreLight, "ink-3"), token(light, "surface")], ["light, Increase contrast", token(moreLight, "ink-3"), token(light, "paper")],
      ["dark, Increase contrast", token(moreDark, "ink-3"), token(dark, "surface")], ["dark, Increase contrast", token(moreDark, "ink-3"), token(dark, "paper")],
    ];
    for (const [what, ink, bg] of pairs) {
      expect(ink, what).toMatch(/^#/u);
      expect(bg, what).toMatch(/^#/u);
      expect(ratio(ink, bg), `${what} ${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // As measured for the audit: 6.14 on the light surface, 6.12 on the dark one.
    expect(ratio(token(light, "ink-3"), token(light, "surface"))).toBeCloseTo(6.14, 2);
    expect(ratio(token(dark, "ink-3"), token(dark, "surface"))).toBeCloseTo(6.12, 2);
  });

  it("Church rules: what an empty scheduled-lead box means is help text tied to every team's box, not a hint", () => {
    const html = renderToStaticMarkup(React.createElement(RulesPage, { rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 }, onChange: () => undefined,
      positions: [{ position_id: "1", team_id: "t1", name: "Greeter", interval: null }, { position_id: "2", team_id: "t2", name: "Nursery", interval: null }] }));
    expect(LEAD_EMPTY_HELP).toBe("Leave a team's box empty if that team doesn't need a scheduled lead.");
    expect(html).toContain(`<p class="small" id="lead-empty-help">${LEAD_EMPTY_HELP.replaceAll("'", "&#x27;")}</p>`);
    expect(html.match(/<input id="lead-t\d"[^>]*aria-describedby="lead-empty-help"/gu)).toHaveLength(2);
    expect(html).not.toContain("No scheduled lead required");
    expect(html).not.toMatch(/<input id="lead-[^>]*placeholder=/u);
  });

  it("Ask: while nothing can be asked yet, the box says why in words beside it", () => {
    const html = renderToStaticMarkup(React.createElement(AskPanel, { open: true, onClose: () => {}, ask: null, brief: null, modelReady: false, onOpen: () => {} }));
    expect(html).toContain(`<p id="ask-unavailable" class="small ask-unavailable">${ASK_UNAVAILABLE.replaceAll("'", "&#x27;")}</p>`);
    expect(html).toMatch(/<textarea id="ask-input"[^>]*disabled=""[^>]*aria-describedby="ask-unavailable"/u);
    expect(html).not.toMatch(/placeholder="Ask Ozzie isn/u);
    const ready = renderToStaticMarkup(React.createElement(AskPanel, { open: true, onClose: () => {}, ask: () => new Promise<never>(() => {}), brief: null, modelReady: false, onOpen: () => {} }));
    expect(ready).not.toContain("ask-unavailable");
  });
});
