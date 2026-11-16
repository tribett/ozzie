// Calendar text stays on this Mac (lane B1 safety rule, like background-check facts): it is never part of a model
// request, a notice or the copy for other AI apps. Proven structurally: no module that builds or sends one of those
// imports the calendar code, directly or through anything it imports. The boundary is found two ways, so a new
// module is covered without editing this list: every source file that names a native command which reaches a model,
// sends a notice or writes the shared copy, plus the modules known to build model requests, fact lines, Church rules
// entries and the shared copy. The calendar code, in turn, calls only the calendar commands.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const SOURCES = ["core/src", "core/mcp", "product/src", "product/desktop/src"];

function files(dir: string): string[] {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full).flatMap(name => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith("dist")) return [];
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}
const ALL = SOURCES.flatMap(files);
const source = (path: string) => readFileSync(join(ROOT, path), "utf8");

const IMPORT = /(?:import|export)\s+(type\s+)?[^"';]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/gu;
/**
 * The source files a module imports (relative imports only; packages can't reach the calendar code). `types`: whether
 * a type-only import counts. Toward the calendar code it always does (a model builder may not even name its types);
 * from it, a type-only import carries no code that could send anything.
 */
function imports(path: string, types = true): string[] {
  const out: string[] = [];
  for (const m of source(path).matchAll(IMPORT)) {
    if (m[1] && !types) continue;
    const spec = (m[2] ?? m[3] ?? m[4] ?? "").split("?")[0]!;
    if (!spec.startsWith(".")) continue;
    const base = relative(ROOT, resolve(ROOT, dirname(path), spec));
    const found = [base, base.replace(/\.js$/u, ".ts"), base.replace(/\.js$/u, ".tsx"), `${base}.ts`, `${base}/index.ts`].find(p => /\.(ts|tsx)$/u.test(p) && existsSync(join(ROOT, p)));
    if (found) out.push(found);
  }
  return out;
}
/** Everything `path` reaches through its imports, itself included. */
function reach(path: string, types = true): Set<string> {
  const seen = new Set<string>([path]);
  const todo = [path];
  while (todo.length) for (const next of imports(todo.pop()!, types)) if (!seen.has(next)) { seen.add(next); todo.push(next); }
  return seen;
}

const CALENDAR = (path: string) => path.startsWith("core/src/calendar/") || /^product\/desktop\/src\/(calendars\.ts|calendar-[\w-]+\.tsx?)$/u.test(path);
/** Native commands that reach a model (any route), send a notice, or write the copy for other AI apps. */
const SENDING = ["ask_ozzie", "reword_draft", "agent_step", "responsibility_agent_step", "share_last_check", "notify_sunday_attention", "notify_ozzie", "managed_connect"];
/** Modules that build what a model, a notice or another AI app is given. */
const BUILDERS = [
  "core/src/ask.ts", "core/src/draft-request.ts", "core/src/egress.ts", "core/src/broker.ts", "core/src/finding-feedback.ts", "core/src/kids-rules.ts",
  "core/src/reminder-draft.ts", "core/src/escalation-draft.ts", "core/src/coverage-drafts.ts",
  "product/desktop/src/ask-panel.tsx", "product/desktop/src/draft-actions.tsx", "product/desktop/src/finding-feedback.tsx", "product/desktop/src/sunday-ready.tsx",
];
const boundary = [...new Set([
  ...ALL.filter(p => !CALENDAR(p) && SENDING.some(c => source(p).includes(`"${c}"`))),
  ...ALL.filter(p => p.startsWith("core/src/harness/") || p.startsWith("core/mcp/")),
  ...BUILDERS,
])].sort();

describe("calendar text never reaches a model, a notice or the copy for other AI apps", () => {
  it("finds the boundary it checks, and the walker does reach the calendar code from where it is used", () => {
    // Every file that names a sending command today, found by the rule rather than listed.
    for (const p of ["product/desktop/src/model.ts", "product/desktop/src/share-check.ts", "product/desktop/src/harness-bridge.ts",
      "product/desktop/src/responsibility-runner.ts", "product/desktop/src/proactive.ts", "product/desktop/src/background.ts", "core/src/harness/pi-loop.ts"]) {
      expect(boundary).toContain(p);
    }
    expect(boundary.every(p => existsSync(join(ROOT, p)))).toBe(true);
    // Sanity: Today and Settings are where calendars are shown, so the walker must find the calendar code from them.
    expect([...reach("product/desktop/src/today-page.tsx")].some(CALENDAR)).toBe(true);
    expect([...reach("product/desktop/src/App.tsx")].some(CALENDAR)).toBe(true);
  });

  it("no module on the boundary imports the calendar code, even indirectly", () => {
    const leaks = boundary.flatMap(p => [...reach(p)].filter(CALENDAR).map(c => `${p} → ${c}`));
    expect(leaks).toEqual([]);
  });

  // Review C2, N3: a go-between module could hand calendar text on under a name the checks above don't follow. Only
  // these modules may import the calendar code at all (type imports included); any other importer fails here.
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

  it("the calendar code calls only calendar commands, logs nothing and imports nothing that sends", () => {
    const calendarFiles = ALL.filter(CALENDAR);
    expect(calendarFiles.length).toBeGreaterThanOrEqual(6);
    for (const p of calendarFiles) {
      const text = source(p);
      expect(text, p).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/u);
      for (const c of SENDING) expect(text, p).not.toContain(`"${c}"`);
      // Only calendars.ts talks to native code, and only through the calendar commands.
      if (p !== "product/desktop/src/calendars.ts") expect(text, p).not.toContain("@tauri-apps");
      for (const imported of reach(p, false)) expect(boundary, `${p} reaches ${imported}`).not.toContain(imported);
    }
    const bridge = source("product/desktop/src/calendars.ts");
    const named = [...bridge.matchAll(/call<[^>]*>\(\s*"([a-z_]+)"/gu)].map(m => m[1]);
    expect(named.length).toBeGreaterThanOrEqual(8);
    for (const c of named) expect(c).toMatch(/^calendar_/u);
    expect(bridge.match(/invoke<T>\(command, args\)/gu)?.length).toBe(1);
  });
});
