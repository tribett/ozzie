// A chosen chip or row reads as chosen without colour (accessibility audit M9): the fill alone was 1.17:1 against an
// unchosen one, so each shows a tick and a 2px accent edge, and says aria-pressed. Fixed words only.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OtherAiAppsSetup } from "../src/other-ai-apps-setup.js";
import { SETUP_APPS } from "../../../core/mcp/setup.js";

const css = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

describe("chosen, without relying on colour", () => {
  it("Other AI apps: only the chosen app's chip has the tick, and every chip says whether it is pressed", () => {
    const html = renderToStaticMarkup(React.createElement(OtherAiAppsSetup, { on: true, path: "/Applications/Ozzie.app/Contents/MacOS/ozzie-share" }));
    const chips = [...html.matchAll(/<button type="button" class="chip" aria-pressed="(true|false)">(.*?)<\/button>/gu)];
    expect(chips).toHaveLength(SETUP_APPS.length);
    for (const [, pressed, inner] of chips) expect(inner!.includes("<svg"), inner).toBe(pressed === "true");
    expect(chips.filter(c => c[1] === "true")).toHaveLength(1);
    expect(css("styles.css")).toContain('.oz .setup-apps .chip[aria-pressed="true"] { background: var(--accent-tint); color: var(--accent-ink); border: 2px solid var(--accent); padding: 0 13px; }');
  });

  it("the AI model rows and first run's services show a tick when chosen, and a 2px accent edge", () => {
    expect(src("ai-this-mac.tsx").match(/\{chosen && <Icon name="check" small \/>\}<span>/gu)).toHaveLength(2);
    expect(css("ai-screens.css")).toMatch(/\.oz \.ai-row\[aria-pressed="true"\] \{ border: 2px solid var\(--accent\);/u);
    expect(src("your-service.tsx")).toContain('<span className="fr-service-t">{service?.id === s.id && <Icon name="check" small />}{nameOf(s)}</span>');
    expect(css("first-run.css")).toMatch(/\.oz \.fr-service\[aria-pressed="true"\] \{ border: 2px solid var\(--accent\);/u);
  });
});
