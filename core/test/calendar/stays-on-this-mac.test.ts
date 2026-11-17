// Calendar text stays on this Mac (lane B1 safety rule, like background-check facts): it is never part of a model
// request, a notice or the copy for other AI apps. Checked structurally, on Ozzie's own code at every change (not a
// sandbox): no module that builds or sends one of those imports the calendar code, directly or through anything it
// imports (the walker in core/test/stays-on-this-mac-imports.ts, which fails on any import it can't follow). The
// boundary is found two ways, so
// a new module is covered without editing this list: every source file that names, in any quote, a native command
// which reaches a model, sends a notice or writes the shared copy, plus the modules known to build model requests, fact
// lines, Church rules entries and the shared copy. The calendar code, in turn, calls only the calendar commands and
// uses no other way off the page; its one worker (calendars.ts starts calendar-worker.ts to parse a link's text off the
// main thread) is calendar code at both ends. Review S2, finding 1: the bridge refuses any other command at run time
// and names each command as a literal; the calendar code and everything it imports reach none of the page's global
// objects (the worker's own `self`, pinned, aside), no Tauri internals and no page-wide events; and no sending module
// reads the page's text.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL, AROUND_THE_BRIDGE, bridgeProblems, code, globalRefs, hatchProblems, imports, NATIVE_COMMANDS, names, OFF_THE_PAGE_APIS, PAGE_TEXT_READS, reach, ROOT, source, unfollowed,
} from "../stays-on-this-mac-imports.js";

const CALENDAR = (path: string) => path.startsWith("core/src/calendar/") || /^product\/desktop\/src\/(calendars\.ts|calendar-[\w-]+\.(?:tsx?|jsx?|mjs))$/u.test(path);
/** Native commands that reach a model (any route), send a notice, or write the copy for other AI apps. */
const SENDING = ["reword_draft", "agent_step", "responsibility_agent_step", "share_last_check", "notify_sunday_attention", "notify_ozzie", "managed_connect"];
/** Modules that build what a model, a notice or another AI app is given. */
const BUILDERS = [
  "core/src/ask.ts", "core/src/draft-request.ts", "core/src/broker.ts", "core/src/finding-feedback.ts", "core/src/kids-rules.ts",
  "core/src/reminder-draft.ts", "core/src/escalation-draft.ts",
  "product/desktop/src/ask-panel.tsx", "product/desktop/src/draft-actions.tsx", "product/desktop/src/finding-feedback.tsx", "product/desktop/src/sunday-ready.tsx",
];
const boundary = [...new Set([
  ...ALL.filter(p => !CALENDAR(p) && SENDING.some(c => names(source(p), c))),
  ...ALL.filter(p => p.startsWith("core/src/harness/") || p.startsWith("core/mcp/")),
  ...BUILDERS,
])].sort();

/** The calendar's worker: started in calendars.ts from this module, the two ends the only calendar code that posts messages. */
const WORKER = "product/desktop/src/calendar-worker.ts";
const BRIDGE = "product/desktop/src/calendars.ts";
const WORKER_START = /new Worker\(new URL\("\.\/calendar-worker\.ts", import\.meta\.url\), \{ type: "module" \}\)/gu;

describe("calendar text never reaches a model, a notice or the copy for other AI apps", () => {
  it("finds the boundary it checks, and the walker does reach the calendar code from where it is used", () => {
    // Every file that names a sending command today, found by the rule rather than listed.
    for (const p of ["product/desktop/src/model.ts", "product/desktop/src/share-check.ts", "product/desktop/src/harness-bridge.ts",
      "product/desktop/src/responsibility-runner.ts", "product/desktop/src/proactive.ts", "product/desktop/src/background.ts", "core/src/harness/pi-loop.ts"]) {
      expect(boundary).toContain(p);
    }
    expect(boundary.every(p => existsSync(join(ROOT, p)))).toBe(true);
    for (const c of SENDING) expect(NATIVE_COMMANDS, c).toContain(c);
    // Sanity: Today and Settings are where calendars are shown, so the walker must find the calendar code from them.
    expect([...reach("product/desktop/src/today-page.tsx")].some(CALENDAR)).toBe(true);
    expect([...reach("product/desktop/src/App.tsx")].some(CALENDAR)).toBe(true);
    // The worker is followed from where it is started: the calendar code and the church's time zone rules, nothing else.
    expect(imports(BRIDGE)).toContain(WORKER);
    expect([...reach(WORKER, false)].filter(p => !CALENDAR(p))).toEqual(["core/src/church-time.ts"]);
  }, 60_000);

  it("follows every import in the app's source folders: none resolves to nothing, to JavaScript from TypeScript, or is computed", () => {
    expect(unfollowed()).toEqual([]);
  });

  it("no module on the boundary imports the calendar code, even indirectly", () => {
    const leaks = boundary.flatMap(p => [...reach(p)].filter(CALENDAR).map(c => `${p} → ${c}`));
    expect(leaks).toEqual([]);
  });

  // Review C2, N3: a go-between module could hand calendar text on under a name the checks above don't follow. Only
  // these modules may import the calendar code at all (type imports included, JavaScript files included); any other
  // importer fails here.
  it("only the calendar's own modules, Today and the app that wires them import the calendar code", () => {
    const allowed = new Set([
      ...ALL.filter(CALENDAR),
      "product/desktop/src/App.tsx",
      "product/desktop/src/today-page.tsx",
    ]);
    const importers = ALL.filter(p => imports(p).some(CALENDAR) && !allowed.has(p));
    expect(importers).toEqual([]);
    // What does import it today, so the list above is the real one and not wider than needed.
    expect(ALL.filter(p => !CALENDAR(p) && imports(p).some(CALENDAR)).sort()).toEqual(["product/desktop/src/App.tsx", "product/desktop/src/today-page.tsx"]);
  });

  // Session B merge: what Siri and Shortcuts hear (core/mcp/shortcuts.ts, run in the helper from shortcuts-embedded.ts)
  // and everything else in core/mcp reach neither the calendar code nor the church reads (People forms, Check-Ins,
  // Registrations), even indirectly and counting type imports.
  it("Siri and Shortcuts, and the rest of core/mcp, reach no calendar or church-reads code", () => {
    const mcp = ALL.filter(p => p.startsWith("core/mcp/"));
    expect(mcp).toContain("core/mcp/shortcuts.ts");
    const churchReads = (p: string) => p.startsWith("core/src/church-reads/");
    expect(ALL.some(churchReads)).toBe(true);
    for (const p of mcp) expect([...reach(p)].filter(r => CALENDAR(r) || churchReads(r)), p).toEqual([]);
  });

  it("the calendar code calls only calendar commands, logs nothing, has no other way off the page and imports nothing that sends", () => {
    const calendarFiles = ALL.filter(CALENDAR);
    expect(calendarFiles.length).toBeGreaterThanOrEqual(6);
    for (const p of calendarFiles) {
      let text = source(p);
      // The worker's start and its messages, at its two ends only (checked below), are the one exception.
      if (p === BRIDGE) text = text.replace(WORKER_START, "").replace(/\bworker\.postMessage\(/gu, "");
      if (p === WORKER) text = text.replace(/\bscope\.postMessage\(|\bpostMessage\(read: CalendarRead\): void/gu, "");
      expect(text, p).not.toMatch(OFF_THE_PAGE_APIS);
      for (const c of SENDING) expect(names(text, c), `${p} names ${c}`).toBe(false);
      // Any native command it names is a calendar command.
      const named = [...text.matchAll(/["'`]([a-z][a-z0-9_]*)["'`]/gu)].map(m => m[1]!).filter(c => NATIVE_COMMANDS.includes(c));
      for (const c of named) expect(c, `${p} names ${c}`).toMatch(/^calendar_/u);
      // Only calendars.ts talks to native code, and only through the calendar commands.
      if (p !== BRIDGE) expect(text, p).not.toContain("@tauri-apps");
      for (const imported of reach(p, false)) expect(boundary, `${p} reaches ${imported}`).not.toContain(imported);
    }
    // The worker is started once, from a module that is calendar code itself, and nothing else posts a message.
    expect(source(BRIDGE).match(WORKER_START)?.length).toBe(1);
    expect(source(BRIDGE).match(/postMessage/gu)?.length).toBe(1);
    expect(source(WORKER).match(/postMessage/gu)?.length).toBe(2);
  });

  it("the bridge lists only calendar commands, refuses any other at run time, and sends each by a literal name", () => {
    const list = /CALENDAR_COMMANDS\s*=\s*\[([^\]]*)\]/u.exec(source(BRIDGE))?.[1];
    const commands = [...(list ?? "").matchAll(/["'`]([^"'`]+)["'`]/gu)].map(m => m[1]!);
    expect(commands.length).toBeGreaterThanOrEqual(8);
    for (const c of commands) expect(c).toMatch(/^calendar_[a-z_]+$/u);
    expect(bridgeProblems(BRIDGE, "CALENDAR_COMMANDS", commands)).toEqual([]);
  });

  it("the calendar code, and everything it imports, uses none of the page's globals (the worker's own scope aside), Tauri internals or page-wide events", () => {
    const own = ALL.filter(CALENDAR);
    const reached = [...new Set(own.flatMap(p => [...reach(p, false)]))].sort();
    expect(reached.filter(p => !CALENDAR(p))).toEqual(["core/src/church-time.ts", "product/desktop/src/icons.tsx"]);
    for (const p of reached) {
      const refs = globalRefs(p).map(r => `${r.name}: ${r.text}`);
      // The worker reaches its own scope once, to receive a job and post back what it read (checked above).
      if (p === WORKER) expect(refs).toEqual(["self: const scope = self as unknown as { onmessage: ((event: MessageEvent<Job>) => void) | null; postMessage(read: CalendarRead): void };"]);
      else expect(refs, p).toEqual([]);
      expect(source(p), p).not.toMatch(AROUND_THE_BRIDGE);
      if (!CALENDAR(p)) expect(source(p), p).not.toMatch(OFF_THE_PAGE_APIS);
    }
  });

  // Review U, finding 1: the ways around the word lists, found with the type checker. The worker's own scope is the one
  // exception, as above.
  it("the calendar code, and everything it imports, uses no way around those checks", () => {
    const reached = [...new Set(ALL.filter(CALENDAR).flatMap(p => [...reach(p, false)]))].sort();
    expect(reached.flatMap(hatchProblems)).toEqual([`${WORKER}:7: reaches the page's window or document: self`]);
  }, 60_000);

  it("no sending module, nor anything it imports, reads the page's text", () => {
    const reached = [...new Set(boundary.flatMap(p => [...reach(p, false)]))].filter(p => !CALENDAR(p));
    for (const p of reached) expect(code(p), p).not.toMatch(PAGE_TEXT_READS);
  });
});
