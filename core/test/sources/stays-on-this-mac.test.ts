// Church-added lists and notes stay on this Mac: their text (and their labels, file names, link addresses, headers,
// chosen columns, matched values and attached sections) is never part of a model request, a notice on this Mac or the
// phone, the copy for other AI apps or Siri, the briefing read aloud, or a draft handed to Mail or Messages. It is shown
// only on this Mac, as the church's own words. Checked structurally (a check on Ozzie's own code on every change, not a
// sandbox: review U, finding 1), as calendar text is
// (core/test/calendar/stays-on-this-mac.test.ts; both use the walker in core/test/stays-on-this-mac-imports.ts): no
// module that builds or sends one of those imports the church-sources code, directly or through anything it imports,
// and every import the walker can't follow fails the proof. The boundary is found by rule, so a new module is covered
// without editing this list: every source file that names a native command which sends (in any quote), plus the
// modules known to build what is sent. The church-sources code, in turn, calls only `church_*` native commands, logs
// and stores nothing, renders no link or image, and uses no other way off the page (a notice, a worker, sharing,
// speech, the window's title), and neither does anything it imports. Review S2, finding 1: its one bridge to native code
// refuses any other command at run time and names each command as a literal, so no name can be built as it runs; it
// reaches none of the page's global objects (a value left on one is readable by any module), no Tauri internals and no
// page-wide events; and no sending module reads the page's text, so the box beside a Sunday card can't be read back.
//
// The page side is the bridge church-sources.ts (and any church-sources-*.ts helper), church-lists-page.tsx,
// church-own-words.tsx and the notes and link parts of the page (church-notes*.tsx, church-link*.tsx).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL, AROUND_THE_BRIDGE, bridgeProblems, code, codeWithoutImports, effectsOf, globalRefs, hatchProblems, imports, NATIVE_COMMANDS, names, OFF_THE_PAGE_APIS,
  PAGE_TEXT_READS, reach, readsOutsideClicks, ROOT, sharedStateProblems, source, TIMERS, unfollowed,
} from "../stays-on-this-mac-imports.js";

const APP = "product/desktop/src/App.tsx";
/** The type checker reads the app's whole program once (about 2 s alone, 6 s or more beside the full run). */
const HATCH_TIME_LIMIT_MS = 60_000;
/** The page bridge: the one file that talks to native code for church sources. */
const BRIDGE = "product/desktop/src/church-sources.ts";
/** The page side, by name: the bridge (and any church-sources-*.ts helper), the page and its parts, and the slot's renderer. */
const PAGE_SIDE = (path: string) =>
  /^product\/desktop\/src\/(?:church-sources(?:-[\w-]+)?\.(?:ts|js|mjs)|church-(?:lists-page|own-words|notes(?:-[\w-]+)?|links?(?:-[\w-]+)?)\.(?:tsx|jsx|ts|js))$/u.test(path);
const CHURCH_SOURCE = (path: string) => path.startsWith("core/src/sources/") || PAGE_SIDE(path);

/** Native commands that reach a model (any route), send a notice, or write the copy for other AI apps or for Siri. */
const SENDING = ["reword_draft", "agent_step", "responsibility_agent_step", "share_last_check", "notify_sunday_attention", "notify_ozzie", "managed_connect", "save_shortcuts_check"];
/**
 * The phone notice's own sending command, once there is one that carries text. Today the phone notice rides on the two
 * notice commands above (src-tauri/src/phone_notice.rs), and phone_notice_test sends a fixed line; add a command here
 * if that changes.
 */
const PHONE_NOTICE_SENDING: readonly string[] = [];
/** Commands that carry text off the page on this Mac: the briefing read aloud, and a draft opened in Mail or Messages. */
const OFF_THE_PAGE = ["speak_briefing", "open_draft", "open_draft_to", "open_in_planning_center"];
const OUTWARD = [...SENDING, ...PHONE_NOTICE_SENDING, ...OFF_THE_PAGE];
/** Modules that build what a model, a notice, Siri or another AI app is given (the calendar test's list, and the brief and listen-script builders). */
const BUILDERS = [
  "core/src/ask.ts", "core/src/draft-request.ts", "core/src/broker.ts", "core/src/finding-feedback.ts", "core/src/kids-rules.ts",
  "core/src/reminder-draft.ts", "core/src/escalation-draft.ts", "core/src/sunday-brief.ts", "core/src/spoken-briefing.ts",
  "product/desktop/src/ask-panel.tsx", "product/desktop/src/draft-actions.tsx", "product/desktop/src/finding-feedback.tsx", "product/desktop/src/sunday-ready.tsx",
];
const boundary = [...new Set([
  ...ALL.filter(p => !CHURCH_SOURCE(p) && OUTWARD.some(c => names(source(p), c))),
  ...ALL.filter(p => p.startsWith("core/src/harness/") || p.startsWith("core/mcp/")),
  ...BUILDERS,
])].sort();

describe("church-added lists and notes never reach a model, a notice, Siri or the copy for other AI apps", () => {
  it("finds the boundary it checks, and the walker does reach the church-sources code from where it is used", () => {
    // Every file that names a sending command today, found by the rule rather than listed.
    for (const p of ["product/desktop/src/model.ts", "product/desktop/src/share-check.ts", "product/desktop/src/harness-bridge.ts",
      "product/desktop/src/responsibility-runner.ts", "product/desktop/src/proactive.ts", "product/desktop/src/background.ts", "core/src/harness/pi-loop.ts",
      "product/desktop/src/siri-shortcuts.ts", "product/desktop/src/briefing.tsx", "product/desktop/src/draft-actions.tsx", "core/mcp/shortcuts.ts"]) {
      expect(boundary).toContain(p);
    }
    expect(boundary.every(p => existsSync(join(ROOT, p)))).toBe(true);
    // The command lists name real native commands.
    expect(NATIVE_COMMANDS.length).toBeGreaterThan(40);
    for (const c of [...SENDING, ...PHONE_NOTICE_SENDING, ...OFF_THE_PAGE]) expect(NATIVE_COMMANDS, c).toContain(c);
    // The church-sources core exists, and the walker follows its own imports.
    const core = ALL.filter(p => p.startsWith("core/src/sources/"));
    expect(core).toEqual(expect.arrayContaining(["core/src/sources/text.ts", "core/src/sources/sheet.ts", "core/src/sources/match.ts", "core/src/sources/notes.ts", "core/src/sources/words.ts", "core/src/sources/types.ts"]));
    expect([...reach("core/src/sources/match.ts", false)]).toEqual(expect.arrayContaining(["core/src/sources/text.ts", "core/src/sources/sheet.ts", "core/src/sources/types.ts"]));
    // The app that shows the Church lists page reaches it.
    expect([...reach(APP)]).toContain("product/desktop/src/church-lists-page.tsx");
    // Every page-side module there is today is counted as church-sources code, the private link's form among them, and
    // the app reaches each one (so none is dead code the checks below would pass by default).
    const pageSide = ALL.filter(PAGE_SIDE).sort();
    expect(pageSide).toEqual(["product/desktop/src/church-link-form.tsx", "product/desktop/src/church-lists-page.tsx", "product/desktop/src/church-notes.tsx",
      "product/desktop/src/church-own-words.tsx", "product/desktop/src/church-sources.ts"]);
    for (const p of pageSide) expect([...reach(APP)], p).toContain(p);
  }, HATCH_TIME_LIMIT_MS);

  it("follows every import in the app's source folders: none resolves to nothing, to JavaScript from TypeScript, or is computed", () => {
    expect(unfollowed()).toEqual([]);
  });

  it("no module on the boundary imports the church-sources code, even indirectly", () => {
    const leaks = boundary.flatMap(p => [...reach(p)].filter(CHURCH_SOURCE).map(c => `${p} → ${c}`));
    expect(leaks).toEqual([]);
  });

  // A go-between could hand source text on under a name the checks above don't follow. Only the church-sources modules
  // themselves and the app that wires them import any of it (type imports included); any other importer fails here,
  // JavaScript files included.
  it("only the church-sources modules and App.tsx import the church-sources code; the Sunday page and Today import none of it", () => {
    const importers = ALL.filter(p => !CHURCH_SOURCE(p) && imports(p).some(CHURCH_SOURCE));
    expect(importers.filter(p => p !== APP)).toEqual([]);
    // The page side is the app's alone: nothing in core imports it.
    expect(ALL.filter(p => p.startsWith("core/") && imports(p).some(PAGE_SIDE))).toEqual([]);
    // The Sunday page gets rows and notes through a slot App.tsx passes; it imports no source code (it is imported by
    // sunday-ready.tsx, which builds model requests). Today shows no list or note.
    for (const p of ["product/desktop/src/sunday-page.tsx", "product/desktop/src/today-page.tsx"]) expect([...reach(p)].filter(CHURCH_SOURCE), p).toEqual([]);
    // App.tsx itself names no command that sends (it would then be on the boundary, which it reaches the sources from).
    for (const c of OUTWARD) expect(names(source(APP), c), c).toBe(false);
  });

  it("Siri and Shortcuts, the copy for other AI apps and the rest of core/mcp reach no church-sources code", () => {
    const mcp = ALL.filter(p => p.startsWith("core/mcp/"));
    expect(mcp).toContain("core/mcp/shortcuts.ts");
    expect(mcp).toContain("core/mcp/snapshot.ts");
    for (const p of mcp) expect([...reach(p)].filter(CHURCH_SOURCE), p).toEqual([]);
  });

  it("the church-sources code calls only church_* commands, logs and stores nothing, shows no link or image, has no other way off the page, and imports nothing that sends", () => {
    const own = ALL.filter(CHURCH_SOURCE);
    expect(own.length).toBeGreaterThanOrEqual(6);
    for (const p of own) {
      const text = source(p);
      expect(text, p).not.toMatch(OFF_THE_PAGE_APIS);
      expect(text, p).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|DOMParser|<a[\s>]|<img[\s>/]|<iframe|<object|<embed|mailto:|sms:/u);
      // Any native command it names is one of the church-sources commands.
      const named = [...text.matchAll(/["'`]([a-z][a-z0-9_]*)["'`]/gu)].map(m => m[1]!).filter(c => NATIVE_COMMANDS.includes(c));
      for (const c of named) expect(c, `${p} names ${c}`).toMatch(/^church_/u);
      for (const c of OUTWARD) expect(names(text, c), `${p} names ${c}`).toBe(false);
      // Only the bridge talks to native code; the core never does.
      if (p !== BRIDGE) expect(text, p).not.toContain("@tauri-apps");
      for (const imported of reach(p, false)) expect(boundary, `${p} reaches ${imported}`).not.toContain(imported);
    }
    // The core has no native calls at all.
    for (const p of own.filter(x => x.startsWith("core/"))) expect(source(p), p).not.toMatch(/\binvoke\b/u);
  });

  it("the bridge lists only church_* commands, refuses any other at run time, and sends each by a literal name", () => {
    const bridge = source(BRIDGE);
    const list = /SOURCE_COMMANDS\s*=\s*\[([^\]]*)\]/u.exec(bridge)?.[1];
    expect(list, "church-sources.ts has a SOURCE_COMMANDS list").toBeDefined();
    const commands = [...list!.matchAll(/["'`]([^"'`]+)["'`]/gu)].map(m => m[1]!);
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(c).toMatch(/^church_[a-z_]+$/u);
    // One import from Tauri (invoke), one guarded call to it, and every command a literal from the list.
    expect(bridgeProblems(BRIDGE, "SOURCE_COMMANDS", commands)).toEqual([]);
  });

  it("the church-sources code, and everything it imports, uses none of the page's globals, Tauri internals or page-wide events", () => {
    const own = ALL.filter(CHURCH_SOURCE);
    const reached = [...new Set(own.flatMap(p => [...reach(p, false)]))].sort();
    // What it reaches beyond its own modules, so the list checked is the real one.
    expect(reached.filter(p => !CHURCH_SOURCE(p))).toEqual(["product/desktop/src/icons.tsx"]);
    for (const p of reached) {
      const text = source(p);
      expect(globalRefs(p), p).toEqual([]);
      expect(text, p).not.toMatch(AROUND_THE_BRIDGE);
      expect(text, p).not.toMatch(OFF_THE_PAGE_APIS);
    }
  });

  // Review U, finding 1: the ways around the word lists above, found with the type checker (a `declare`, anything typed
  // as the page's window or document however it was reached, a key made at run time, a write onto a built-in, an event
  // prop no one asks for, the built-ins any module can read). A check on Ozzie's own code, not a sandbox.
  it("the church-sources code, and everything it imports, uses no way around those checks", () => {
    const reached = [...new Set(ALL.filter(CHURCH_SOURCE).flatMap(p => [...reach(p, false)]))].sort();
    expect(reached.flatMap(hatchProblems)).toEqual([]);
  }, HATCH_TIME_LIMIT_MS);

  it("the page side reads a list or notes only when asked: each effect has a dependency list, and the effects that read are pinned (review U, finding 1)", () => {
    // An effect with no dependency list runs on every render (the clock re-renders the page every second).
    const noDeps = ALL.filter(PAGE_SIDE).flatMap(p => effectsOf(p).filter(e => e.deps === null).map(e => `${p}:${e.line}`));
    expect(noDeps).toEqual([]);
    // Effects that call a read, in the page side and in App.tsx (which wires it): coming to Sunday or Church lists, and
    // the calendars' own two. A new one fails here until it is looked at and added.
    const reading = [...ALL.filter(PAGE_SIDE), APP].flatMap(p => effectsOf(p).filter(e => e.reads).map(e => `${p}: ${e.deps}`));
    expect(reading).toEqual([`${APP}: [calendars]`, `${APP}: [page, visible, calendars, now]`, `${APP}: [page, visible, churchSources]`]);
    // In the page side outside the controller, a read is called only from a button's click.
    expect(ALL.filter(p => PAGE_SIDE(p) && p !== BRIDGE).flatMap(readsOutsideClicks)).toEqual([]);
  });

  it("the church-sources code sets up nothing that runs later on its own: no timer but the bridge's one time limit on a native call (review T, L3)", () => {
    const reached = [...new Set(ALL.filter(CHURCH_SOURCE).flatMap(p => [...reach(p, false)]))];
    const timers = reached.flatMap(p => code(p).split("\n").filter(l => TIMERS.test(l)).map(l => `${p}: ${l.trim()}`));
    expect(timers).toEqual([`${BRIDGE}: const timer = setTimeout(() => reject("unavailable"), ms);`]);
  });

  // Review V, L5: not only the sending side. Every module outside the page side, App.tsx included, is held to it, so a
  // module that isn't a sender today (App reading the box and handing it to a rewording) can't read the box's text off
  // the page. Three modules use the DOM in ways that read no text, pinned here line for line.
  it("no module outside the page side reads the page's text or names its classes; the three DOM uses that read no text are pinned", () => {
    const pinned = [
      "product/desktop/src/main.tsx: createRoot(document.getElementById(\"root\")!).render(<React.StrictMode><App /></React.StrictMode>);",
      "product/desktop/src/rules-page.tsx: document.getElementById(`procedure-${focus}`)?.scrollIntoView?.({ block: \"start\" });",
      "product/desktop/src/cards-page.tsx: document.body.append(area);",
    ];
    const CLASSES = /church-own-words|own-notes|church-list\b|church-lists\b|church-link-form|church-notes|own-table|own-frame|note-line|note-section|note-found|note-text/u;
    const found = ALL.filter(p => !CHURCH_SOURCE(p)).flatMap(p => codeWithoutImports(p).split("\n").filter(l => PAGE_TEXT_READS.test(l) || CLASSES.test(l))
      .map(l => `${p}: ${l.trim()}`));
    expect(found.sort()).toEqual([...pinned].sort());
  });

  it("a module both the page side and the sending side import keeps no state one could write and the other read (review V, L5)", () => {
    const fromPage = new Set(ALL.filter(CHURCH_SOURCE).flatMap(p => [...reach(p, false)]));
    const fromSending = new Set(boundary.flatMap(p => [...reach(p, false)]));
    const shared = [...fromPage].filter(p => !CHURCH_SOURCE(p) && fromSending.has(p)).sort();
    expect(shared).toEqual(["product/desktop/src/icons.tsx"]);
    for (const p of shared) expect(sharedStateProblems(p), p).toEqual([]);
    // The rule finds what it is for, in a module that keeps state.
    expect(sharedStateProblems("product/desktop/src/church-sources.ts").length).toBeGreaterThan(0);
  });

  it("no sending module, nor anything it imports, reads the page's text or names the box beside a Sunday card", () => {
    // Scoped to what a sending module could use to read the church's own words back off the page: the box's and the
    // page's own class names, and the DOM's ways to find an element or read its text. Today none of the boundary, nor
    // anything it reaches, uses any of them; main.tsx (mounting the app), rules-page.tsx (scrolling to a procedure)
    // and cards-page.tsx (a copy helper) do, and none of those is reached from the boundary.
    const reached = [...new Set(boundary.flatMap(p => [...reach(p, false)]))].filter(p => !CHURCH_SOURCE(p)).sort();
    expect(reached.length).toBeGreaterThan(boundary.length);
    for (const p of ["product/desktop/src/main.tsx", "product/desktop/src/rules-page.tsx", "product/desktop/src/cards-page.tsx"]) expect(reached, p).not.toContain(p);
    for (const p of reached) {
      // Code only: sunday-page.tsx says in a comment where the box comes from.
      const text = code(p);
      expect(text, p).not.toMatch(/church-own-words|church-list\b|church-lists\b|church-link-form|own-table|own-frame/u);
      expect(text, p).not.toMatch(PAGE_TEXT_READS);
    }
  });
});
