// Ozzie's bundled helper for Siri and Shortcuts (src-tauri/helpers/shortcuts.swift with the answering it shares with
// Ozzie's Siri actions, helpers/shortcuts-answer.swift; built by build.rs), run as a
// shortcut's Run Shell Script step runs it: each answer compared with core/mcp/shortcuts.ts over the same copy, the
// switch off saying only that, a copy that isn't a plain file read as none, and nothing written. Every run gets its own
// home folder, so the real Ozzie data folder on this Mac is never read. Skipped, saying why, when the helper isn't built
// here or is older than core/mcp. Fictional data only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Rollup } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { HarnessTools } from "../../../core/src/harness/tools.js";
import { MAX_SHARED_BYTES, sharedCheckText, sharedEnvelopes } from "../../../core/mcp/snapshot.js";
import { NO_CHECK, OFF, SHORTCUTS_FILE, SHORTCUTS_ON_FILE, shortcutsAnswer, shortcutsEnvelopes, UNKNOWN_QUESTION } from "../../../core/mcp/shortcuts.js";
import { FRESH, harnessData } from "../../../core/test/harness/fixtures.js";

/** What the helper is built from (build.rs): the answering it shares with Ozzie's Siri actions, and its own entry point. */
const SOURCES = ["shortcuts-answer.swift", "shortcuts.swift"].map(f => new URL(`../src-tauri/helpers/${f}`, import.meta.url));
const source = () => SOURCES.map(s => readFileSync(s, "utf8")).join("\n");
const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const HELPER = new URL(`../src-tauri/binaries/ozzie-shortcuts-${triple}`, import.meta.url).pathname;

async function unavailable(): Promise<string | null> {
  if (process.platform !== "darwin") return "ozzie-shortcuts is a Mac helper";
  if (!existsSync(HELPER)) return `ozzie-shortcuts isn't built (${HELPER}): run \`pnpm build:shortcuts\`, then \`cargo build\` in product/desktop/src-tauri`;
  const built = await build({ configFile: new URL("../../../core/mcp/vite.shortcuts.config.ts", import.meta.url).pathname, logLevel: "silent", build: { write: false, emptyOutDir: false } });
  const script = ((Array.isArray(built) ? built[0]! : built as Rollup.RollupOutput).output[0] as Rollup.OutputChunk).code;
  if (!readFileSync(HELPER).includes(Buffer.from(script, "utf8"))) return "ozzie-shortcuts is older than core/mcp: run `pnpm build:shortcuts`, then `cargo build` in product/desktop/src-tauri";
  return null;
}
const why = await unavailable();
if (why) console.warn(`Skipping the ozzie-shortcuts helper tests: ${why}`);

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
/** A home folder with Ozzie's data folder in it, optionally with the switch on. */
function home(on: boolean): { home: string; folder: string } {
  const h = mkdtempSync(join(tmpdir(), "ozzie-shortcuts-home-"));
  homes.push(h);
  const folder = join(h, "Library", "Application Support", "church.ozzie.desktop");
  mkdirSync(folder, { recursive: true });
  if (on) writeFileSync(join(folder, SHORTCUTS_ON_FILE), "", { mode: 0o600 });
  return { home: h, folder };
}
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/**
 * The helper reads no environment but HOME; TZ is handed on only when this run sets it, because its check time is said
 * on this Mac's clock (TimeZone.current) and the answers it is compared with are worked out in this process's zone. A run
 * with TZ=UTC otherwise compared UTC with the Mac's own zone.
 */
const SAME_ZONE: Record<string, string> = process.env.TZ ? { TZ: process.env.TZ } : {};
function run(h: string, args: string[] = ["sunday"]): string {
  const result = spawnSync(HELPER, args, { env: { HOME: h, ...SAME_ZONE }, timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const out = result.stdout.toString("utf8");
  expect(out.endsWith("\n")).toBe(true);
  return out.slice(0, -1);
}
/** The fictional Sunday's overview as native writes it, or (`current`) checked five minutes ago for a Sunday a week away, as the helper meets it on the real clock. */
async function liveCopy(current = true): Promise<string> {
  const data = harnessData({ mode: "live", now: FRESH });
  const envelopes = shortcutsEnvelopes(await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => FRESH })));
  if (current) {
    const week = new Date(Date.now() + 7 * 86_400_000);
    const day = (n: number) => String(n).padStart(2, "0");
    for (const e of envelopes) {
      e.check_time = new Date(Date.now() - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
      (e.payload as Record<string, unknown>)["sunday"] = `${week.getFullYear()}-${day(week.getMonth() + 1)}-${day(week.getDate())}`;
    }
  }
  return sharedCheckText(envelopes, [], FRESH, "B4K7Q2X9M3T8");
}
const listing = (folder: string) => readdirSync(folder).sort();

describe("ozzie-shortcuts's source", () => {
  it("has no network, process or write call, one read-only open, and reads no environment but HOME", () => {
    const src = source();
    expect(src).not.toMatch(/URLSession|NSURL|CFNetwork|Network\b|socket\(|connect\(|getaddrinfo|Process\(|NSTask|posix_spawn|fork\(|exec[lv]p?\(|system\(|popen\(/u);
    expect(src).not.toMatch(/O_WRONLY|O_RDWR|O_CREAT|O_APPEND|fopen\(|FileManager|createFile|\.write\(to|unlink\(|rename\(|mkdir\(|truncate\(|chmod\(|Darwin\.write/u);
    expect([...src.matchAll(/\bopen\(([^)]*)\)/gu)].map(m => m[1])).toEqual(["path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC"]);
    expect([...src.matchAll(/environment\["(\w+)"\]/gu)].map(m => m[1])).toEqual(["HOME"]);
    expect(src).not.toMatch(/standardInput|readLine\(/u);
    expect([...new Set([...src.matchAll(/^import (\w+)/gmu)].map(m => m[1]))].sort()).toEqual(["Darwin", "Foundation", "JavaScriptCore", "MachO"]);
  });

  it("tells a leader only in plain words when it can't answer at all (review K L5)", () => {
    const src = source();
    // Shortcuts shows what a failing step writes: one plain sentence, whatever went wrong.
    expect(src).toContain('let cannotAnswer = "Ozzie couldn\'t answer. Open Ozzie, or install it again."');
    expect([...src.matchAll(/\bfail\(([^)]*)\)/gu)].every(m => m[1] === "")).toBe(true);
    expect([...src.matchAll(/standardError\.write\(([^\n]*)\)/gu)].map(m => m[1])).toEqual(["Data((cannotAnswer + \"\\n\").utf8)"]);
    const literals = [...src.replace(/^\s*\/\/.*$/gmu, "").matchAll(/"(?:[^"\\]|\\.)*"/gu)].map(m => m[0]);
    for (const text of literals) expect(text, text).not.toMatch(/binary|javascriptcore|script|helper|ozzie-shortcuts|section/iu);
  });
});

describe.skipIf(why !== null)("ozzie-shortcuts", () => {
  it("says what core/mcp/shortcuts.ts says over the same copy", async () => {
    const { home: h, folder } = home(true);
    const copy = await liveCopy();
    writeFileSync(join(folder, SHORTCUTS_FILE), copy, { mode: 0o600 });
    const before = Date.now();
    const said = run(h);
    const expected = [before, Date.now()].map(nowMs => shortcutsAnswer("sunday", { on: true, text: copy, nowMs, timeZone: ZONE }));
    expect(expected).toContain(said);
    expect(said).toContain("2 open spots across 2 roles");
    expect(said).toContain("Checked in Planning Center today at");
    // The fixture's own check time, a fixed day: whatever the real clock makes of it, the helper says what shortcuts.ts says.
    const fixed = await liveCopy(false);
    writeFileSync(join(folder, SHORTCUTS_FILE), fixed, { mode: 0o600 });
    const again = run(h);
    expect([Date.now() - 1000, Date.now()].map(nowMs => shortcutsAnswer("sunday", { on: true, text: fixed, nowMs, timeZone: ZONE }))).toContain(again);
  });

  it("says only that it's turned off without the switch, even beside a copy, and when the switch is a link", async () => {
    const { home: h, folder } = home(false);
    writeFileSync(join(folder, SHORTCUTS_FILE), await liveCopy(), { mode: 0o600 });
    expect(run(h)).toBe(OFF);
    writeFileSync(join(folder, "elsewhere"), "");
    symlinkSync(join(folder, "elsewhere"), join(folder, SHORTCUTS_ON_FILE));
    expect(run(h)).toBe(OFF);
  });

  it("reads a copy that's missing, a link, a pipe, a folder or too large as no saved check", async () => {
    const { home: h, folder } = home(true);
    const path = join(folder, SHORTCUTS_FILE);
    expect(run(h)).toBe(NO_CHECK);
    writeFileSync(join(folder, "real.json"), await liveCopy());
    symlinkSync(join(folder, "real.json"), path);
    expect(run(h)).toBe(NO_CHECK);
    rmSync(path);
    expect(spawnSync("/usr/bin/mkfifo", [path]).status).toBe(0);
    expect(run(h)).toBe(NO_CHECK);
    rmSync(path);
    mkdirSync(path);
    expect(run(h)).toBe(NO_CHECK);
    rmSync(path, { recursive: true });
    writeFileSync(path, " ".repeat(MAX_SHARED_BYTES + 1));
    expect(run(h)).toBe(NO_CHECK);
  });

  it("answers anything but the one question with the fixed words, and writes nothing", async () => {
    const { home: h, folder } = home(true);
    writeFileSync(join(folder, SHORTCUTS_FILE), await liveCopy(), { mode: 0o600 });
    const before = listing(folder);
    for (const args of [[], ["rooms"], ["Sunday"], ["sunday", "extra"], ["--help"], ["$(touch x)"]]) expect(run(h, args)).toBe(UNKNOWN_QUESTION);
    run(h);
    expect(listing(folder)).toEqual(before);
    expect(listing(h)).toEqual(["Library"]);
  });
});
