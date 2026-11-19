// Readable for old eyes and hands (audit items 22, 27 and 29): a card's main actions with the rest under More choices,
// the calm rewording notice, Settings' index, and the CSS rules that keep text, targets and the sidebar readable.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { MoreChoices, SundayPage } from "../src/sunday-page.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture, PEOPLE, TEAMS } from "../../../core/src/fictional-sunday.js";
import type { FeedbackEntry } from "../../../core/src/finding-feedback.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { fictionalOperations } from "../../../core/src/fictional-operations.js";
import type { SundayOperations } from "../../../core/src/operations-capture.js";
import type { FeedbackSource } from "../src/finding-feedback.js";
import { ConnectionPage, SavedRecordings, SETTINGS_SECTIONS } from "../src/connection-page.js";
import { SiriShortcutsSection } from "../src/siri-shortcuts-section.js";
import { DEFAULT_PREFS } from "../src/proactive.js";

const names = nov22Capture().names;
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const feedback: FeedbackSource = { entries: [], onEntries: () => undefined };
function page(b: SundayBrief, operations: SundayOperations | null = null, entries: FeedbackEntry[] = []) {
  return renderToStaticMarkup(React.createElement(SundayPage, {
    brief: b, names, busy: false, problem: "", sender: "Pat", connected: false, hasRecording: false, configured: false,
    canReword: false, decisions: [], onDecisions: () => undefined, operations, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    feedback: entries.length ? { entries, onEntries: () => undefined } : feedback,
  }));
}
/** A card's text as seen with every More choices closed: each hidden fold's box taken out, to its own closing tag. */
function shown(card: string): string {
  let out = card;
  for (let at = out.search(/<div id="[^"]+" class="more-body" hidden="">/u); at >= 0; at = out.search(/<div id="[^"]+" class="more-body" hidden="">/u)) {
    let depth = 0, i = at;
    for (const m of out.slice(at).matchAll(/<div\b|<\/div>/gu)) { depth += m[0] === "</div>" ? -1 : 1; if (depth === 0) { i = at + m.index! + m[0].length; break; } }
    out = out.slice(0, at) + out.slice(i);
  }
  return text(out);
}
/** Each finding card's markup, in page order. */
const cards = (html: string) => html.split("<article").slice(1).map(a => a.slice(0, a.indexOf("</article>")));

describe("More choices (audit item 29)", () => {
  it("is a button that says it's closed and names what it opens; the choices are in the page, hidden until it opens", () => {
    const html = renderToStaticMarkup(React.createElement(MoreChoices, { children: React.createElement("button", { type: "button" }, "Covered outside Planning Center") }));
    const m = /<button type="button" class="btn btn-quiet btn-sm more-toggle" aria-expanded="false" aria-controls="([^"]+)">.*More choices<\/button><div id="([^"]+)" class="more-body" hidden="">/u.exec(html);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    expect(html).toContain(">Covered outside Planning Center</button>");
    // Opened, it says so and nothing is hidden.
    const open = renderToStaticMarkup(React.createElement(MoreChoices, { startOpen: true, children: "x" }));
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toMatch(/\shidden=/u);
  });

  const b = { ...buildSundayBrief(nov22Capture(), { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] }, nov22Capture().completed_at, true) };
  const html = page(b, fictionalOperations());
  const all = cards(html);

  it("each card shows at most two main actions before More choices, and Why I flagged this stays in view", () => {
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const card of all) {
      const row = card.indexOf('class="find-next card-actions"');
      if (row < 0) continue;
      const fold = card.indexOf('class="more-choices"', row);
      const main = card.slice(row, fold < 0 ? undefined : fold);
      expect((main.match(/<button/gu) ?? []).length, text(card).slice(0, 80)).toBeLessThanOrEqual(2);
      // Why I flagged this is outside the fold: after the hidden box closes, not inside it.
      if (card.includes("Why I flagged this") && fold >= 0) {
        const body = card.indexOf('class="more-body" hidden=""');
        expect(body).toBeGreaterThan(fold);
        expect(card.lastIndexOf("Why I flagged this")).toBeGreaterThan(body);
      }
    }
  });

  it("an open role shows who could help and its leader note; for this Sunday only and telling Ozzie wait under More choices; nothing is removed", () => {
    const greeter = all.find(c => text(c).includes("Greeter still needs"))!;
    const t = text(greeter);
    expect(t).toMatch(/Hide people More choices For this Sunday only: Covered outside Planning Center Not needed this Sunday This isn't right Always tell me right away Put this in the briefing/u);
    const body = greeter.indexOf('class="more-body" hidden=""');
    for (const words of ["Covered outside Planning Center", "Not needed this Sunday", "This isn&#x27;t right", "Always tell me right away", "Put this in the briefing"]) {
      expect(greeter.indexOf(words), words).toBeGreaterThan(body);
    }
    // A role with no one to list still offers its leader note as a main action.
    const nursery = text(all.find(c => text(c).includes("Nursery still needs"))!);
    expect(nursery).toMatch(/Prepare a note to the team's leader More choices/u);
  });

  it("a lead question keeps “Yes, that's expected” as the one filled button; rooms, follow-ups and groups put telling Ozzie under More choices", () => {
    const lead = all.find(c => text(c).includes("No one is scheduled to lead"))!;
    expect(lead).toMatch(/class="btn btn-sm btn-primary">Yes, that&#x27;s expected<\/button>/u);
    const others = ["has overlapping bookings", "has no owner", "has a group meeting"].map(kind => [kind, all.find(x => text(x).includes(kind))] as const).filter(([, c]) => c);
    expect(others.length).toBeGreaterThanOrEqual(2);
    for (const [kind, c] of others) expect(text(c!), kind).toMatch(/More choices (This isn't right|Stop flagging this|Put this in the briefing)/u);
  });

  it("what a Church rule already does for a card is state, shown with More choices closed, beside the note it opened (review F, L-5)", () => {
    // Lyrics' request was sent and has no answer: a rule prepares the reminder, and open roles are told right away.
    const capture: SundayCapture = nov22Capture();
    const members = capture.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; attributes: Record<string, unknown> }[];
    members.find(m => m.id === "403")!.attributes.notification_sent_at = "2026-11-18T12:00:00Z";
    const AT = "2026-11-20T15:10:00Z";
    const entries: FeedbackEntry[] = [
      { type: "always", id: "a", kind: "pending", at: AT, action: "prepare-reminder", scope: { team_id: TEAMS.lyrics, position: "Lyrics" }, labels: {} },
      { type: "urgency", id: "u", kind: "needs-people", at: AT, level: "right-away" },
    ];
    const html = page(buildSundayBrief(capture, { ...rules, feedback: entries }, capture.completed_at, true), null, entries);
    const lyrics = cards(html).find(c => text(c).includes(`${names[PEOPLE.lyricsPending]} is pending for Lyrics`))!;
    const reason = "Prepared because of your Church rule: “Always prepare a reminder note when a request for Lyrics has no answer yet.”";
    // Out of the closed fold, once, right before the reminder it explains.
    expect(text(lyrics).split(reason)).toHaveLength(2);
    expect(shown(lyrics)).toContain(reason);
    expect(shown(lyrics).indexOf(reason)).toBeLessThan(shown(lyrics).indexOf("Draft only. Nothing has been sent."));
    // How soon Ozzie tells: also in view with the fold closed, on each open role's card, and said once.
    const greeter = cards(html).find(c => text(c).includes("Greeter still needs"))!;
    expect(shown(greeter)).toMatch(/Ozzie tells you right away about /u);
    expect(text(greeter).match(/Ozzie tells you right away about /gu)).toHaveLength(1);
  });

  it("the rewording notice is calm: an info box that says what happened, not a red alert", () => {
    const src = readFileSync(new URL("../src/sunday-page.tsx", import.meta.url), "utf8");
    const draft = src.slice(src.indexOf("export function Draft("), src.indexOf("export function DraftBox("));
    expect(draft).toContain('{problem && <div role="status" className="panel-info reword-note"><Icon name="info" small /><p>{problem}</p></div>}');
    expect(draft).not.toContain('className="problem"');
  });
});

describe("Settings is findable (audit item 27)", () => {
  const settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
  const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(ConnectionPage, {
    status: null, settings, onSettings: () => {}, onStatus: () => {}, prefs: DEFAULT_PREFS, onAutomatic: () => {}, onSetup: () => {}, onLists: () => {},
    phone: React.createElement("section", { className: "find", "aria-labelledby": "phone-title" }, React.createElement("h3", { id: "phone-title" }, "A notice on your phone")),
    calendars: React.createElement("section", { className: "settings-sec", "aria-labelledby": "calendars-title" }, React.createElement("h2", { id: "calendars-title" }, "Calendars")),
    sharing: { on: false, onChange: () => {} }, ...extra,
  }));
  const html = render();

  it("starts with a short index: a labelled list of links, one to each section's heading, in the page's own order", () => {
    const nav = /<nav class="settings-index" aria-labelledby="settings-index-title"><h2 id="settings-index-title" class="eyebrow">On this page<\/h2><ul>(.*?)<\/ul><\/nav>/u.exec(html);
    expect(nav).not.toBeNull();
    const links = [...nav![1]!.matchAll(/<a href="#([^"]+)">.*?<\/svg>([^<]+)<\/a>/gu)].map(m => [m[1]!, m[2]!.replaceAll("&amp;", "&")] as const);
    expect(links.map(([, label]) => label)).toEqual(["Planning Center and which service Ozzie watches", "Your name on notes", "AI help", "What Ozzie runs and notices",
      "Calendars", "Church lists", "Other AI apps, Spotlight and Shortcuts", "Saved checks", "Check my setup"]);
    // Each link's target is a heading on the page, after the index, in the same order as the links.
    const at = links.map(([id]) => html.search(new RegExp(`<h[23] id="${id}"`, "u")));
    expect(at.every(i => i > (nav!.index ?? 0))).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const [id, label] of links) expect(html).toMatch(new RegExp(`<h2 id="${id}"[^>]*>${label.replace("&", "&amp;")}</h2>`, "u"));
  });

  it("names Updates only when there is an Updates section, and Other AI apps only when it can be set", () => {
    const bare = renderToStaticMarkup(React.createElement(ConnectionPage, { status: null, settings, onSettings: () => {}, onStatus: () => {}, phone: null }));
    expect(bare).not.toContain('href="#other-ai-title"');
    expect(bare).not.toContain('href="#updates-title"');
    expect(bare).not.toContain('href="#setup-again"');
    expect(render({ updates: React.createElement("section", { "aria-labelledby": "updates-title" }, React.createElement("h2", { id: "updates-title" }, "Updates")) }))
      .toContain('href="#updates-title"');
  });

  it("moves within the page pane by each section's own element, never with scrollIntoView or a look-up in the page, and gives it the keyboard focus", () => {
    const src = readFileSync(new URL("../src/connection-page.tsx", import.meta.url), "utf8");
    // `align` puts a section in place (also again while Settings opened at one settles, review L6); `go` then focuses it.
    const go = src.slice(src.indexOf("  const align = (id: string) => {"), src.indexOf("  const candidates ="));
    expect(go).toContain("pane.scrollTop += place.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16;");
    expect(go).toContain("const go = (id: string) => align(id)?.focus({ preventScroll: true });");
    // Lists and notes stay on this Mac: Settings reads nothing off the page (core/test/sources/stays-on-this-mac.test.ts).
    expect(src).not.toMatch(/\.scrollIntoView\(|querySelector|getElementById|\.closest\(/u);
    // Every heading the index moves to can take the focus.
    // Calendars, Updates and Other church systems are slots App fills (system-settings.tsx holds the last one's heading).
    for (const { id } of SETTINGS_SECTIONS.filter(s => !["calendars-title", "updates-title", "systems-title"].includes(s.id))) expect(html).toMatch(new RegExp(`<h2 id="${id}" class="h3" tabindex="-1">`, "u"));
    expect(html).toMatch(/<div class="settings-slot" tabindex="-1" role="group" aria-labelledby="calendars-title">/u);
  });

  it("groups the phone notice under what Ozzie runs and notices, and Siri and Shortcuts beside other AI apps", () => {
    const t = text(html);
    expect(t).toMatch(/What Ozzie runs and notices Keeping watch .* A notice on your phone Calendars/u);
    expect(t).toMatch(/Other AI apps, Spotlight and Shortcuts Other AI apps /u);
    expect(text(renderToStaticMarkup(React.createElement(SiriShortcutsSection, { on: false, onChange: () => {}, problem: null, path: null, actions: false }))))
      .toMatch(/^ Siri and Shortcuts /u);
  });

  it("forgetting things on this Mac reads apart from other buttons, without a red fill", () => {
    const saved = renderToStaticMarkup(React.createElement(SavedRecordings, { count: 2, onDelete: () => {}, sharing: false, confirming: true }));
    expect(saved).toMatch(/class="btn btn-forget btn-sm"[^>]*>Delete saved checks<\/button>/u);
    expect(saved).toMatch(/class="btn btn-forget btn-sm"[^>]*>Yes, delete them<\/button>/u);
  });
});

describe("readable text, targets and zoom in the CSS (audit item 22)", () => {
  const raw = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  const hearth = raw("hearth.css"), styles = raw("styles.css");
  const css = [hearth, styles, raw("calendars.css"), raw("church-lists.css")].join("\n");

  it("sizes text from Hearth's tokens: body 16px, secondary 15px, nothing under 14px", () => {
    expect(hearth).toMatch(/--t-xs:14px;--t-sm:15px;--t-md:16px;--t-lg:18px;/u);
    expect(hearth).toMatch(/font-family:var\(--f-ui\);font-size:var\(--t-md\);line-height:1\.5;/u);
    for (const [rule, token] of [[".small{", "--t-sm"], [".input-help{", "--t-sm"], [".find-body{", "--t-md"], [".lede{", "--t-lg"], [".eyebrow{", "--t-xs"]] as const) {
      const at = hearth.indexOf(rule);
      expect(at, rule).toBeGreaterThan(-1);
      expect(hearth.slice(at, hearth.indexOf("}", at)), rule).toContain(`var(${token})`);
    }
    // No literal size under 14px anywhere except Ask's own section (the Ask lane's).
    const ask = /^\.oz \.ask-[^{]*\{[^}]*\}$/gmu;
    const small = [...css.replace(ask, "").matchAll(/font(?:-size)?:[^;}]*?\b(\d+(?:\.\d+)?)px/gu)].map(m => Number(m[1])).filter(n => n < 14);
    expect(small).toEqual([]);
  });

  it("keeps running text to about 70 characters a line", () => {
    expect(styles).toMatch(/\.oz \.lede, \.oz \.find-body, \.oz \.col p\.small, \.oz \.input-help \{ max-width: 34em; \}/u);
  });

  it("draws selects 44px tall instead of WebKit's native 22px one", () => {
    const select = /\.oz select \{([^}]*)\}/u.exec(styles)?.[1] ?? "";
    expect(select).toMatch(/-webkit-appearance: none; appearance: none;/u);
    expect(select).toMatch(/min-height: 44px/u);
  });

  it("keeps the sidebar's words at every width: no icon-only rail, a Menu bar when narrow, nothing in the sidebar shrinks", () => {
    expect(styles).not.toMatch(/\.nav-label[^{]*\{[^}]*clip: rect/u);
    expect(styles).not.toContain("content: attr(data-label)");
    expect(styles).toMatch(/\.oz \.side > \* \{ flex-shrink: 0; \}/u);
    const narrow = styles.slice(styles.search(/@media \(max-width: 760px\) \{\s*\.oz \.shell, /u));
    expect(narrow).toMatch(/\.oz \.side-menu \{ display: inline-flex; \}/u);
    expect(narrow).toMatch(/\.oz \.side\.is-menu \.nav \{ display: grid;/u);
    // Ask docks beside the page only when the page keeps about 650px; otherwise it lies over the page.
    expect(styles).toMatch(/@media \(min-width: 1300px\) \{\s*\.oz \.shell\.shell-ask \{ grid-template-columns: var\(--w-side\) minmax\(0,1fr\) 380px; \}/u);
  });

  it("a narrow window keeps the sidebar's two lines: under Menu with the pages, and the church in use in the bar (review F, L-6)", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    // Menu controls one box: the pages, then that Ozzie only reads and the church in use.
    const box = app.slice(app.indexOf('<div id="side-nav" className="side-pages">'), app.indexOf('className="btn btn-secondary ask-entry"'));
    expect(app).toContain('aria-expanded={menu} aria-controls="side-nav"');
    expect(box).toContain('<nav className="nav" aria-label="Pages">');
    // The promise line comes from promises.ts (onboarding spec §0.2); the AI line follows the church (§4.4).
    expect(box).toMatch(/<div className="side-foot">\s*<p className="quiet-note">.*\{promise\("readsShort"\)\} The names Ozzie reads stay on this Mac\.<\/span><\/p>\s*<p className="small side-org">\{churchLine\}<\/p>\s*\{\/\*[^*]*\*\/\}\s*\{askShown && <div className="small side-ai"><AiLine /u);
    expect(app).toContain('<p className="small side-bar-org">{churchLine}</p>');
    const narrow = styles.slice(styles.search(/@media \(max-width: 760px\) \{\s*\.oz \.shell, /u));
    const block = narrow.slice(0, narrow.indexOf("\n}\n"));
    expect(block).toMatch(/\.oz \.side\.is-menu \.side-pages \{ display: flex;/u);
    expect(block).toMatch(/\.oz \.side-bar-org \{ display: block;[^}]*text-overflow: ellipsis;/u);
    expect(block).not.toMatch(/side-foot[^{]*\{[^}]*display: none/u);
    // Wide: the box steps aside and the two lines sit at the sidebar's foot, under Ask Ozzie.
    expect(styles).toMatch(/\.oz \.side-pages \{ display: contents; \}\s*\.oz \.side-foot \{ order: 2; \}/u);
  });

  it("honours Increase contrast in light and dark, and Reduce motion for every element", () => {
    const more = styles.slice(styles.indexOf("@media (prefers-contrast: more) {"));
    expect(more.length).toBeLessThan(styles.length);
    expect(more).toMatch(/\.oz \{ --ink-2:#3A3226; --ink-3:#3A3226;/u);
    expect(more).toMatch(/\.oz\.dark, \.oz \.dark \{ --ink-2:/u);
    expect(more).toMatch(/text-decoration: underline/u);
    expect(more).toMatch(/outline-width: 4px/u);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.oz \*, \.oz \*::before, \.oz \*::after \{ transition-duration: 0s !important; animation-duration: 0s !important;/u);
    expect(styles).toMatch(/@media \(prefers-reduced-transparency: reduce\)/u);
  });
});
