// Ozzie's bundled helper for other AI apps (src-tauri/helpers/share.swift, built by build.rs): driven over stdio as
// an AI app would, every reply compared byte for byte with the Node server's (core/mcp) on the same shared file and
// the same input. Skipped, saying why, when the helper isn't built on this Mac or is older than core/mcp.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { build, type Rollup } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../../core/src/harness/tools.js";
import { readShared, sharedCheckPath } from "../../../core/mcp/file.js";
import { NOT_SHARED } from "../../../core/mcp/render.js";
import { MAX_BATCH, MAX_LINE, McpServer, serveStream, TOOLS } from "../../../core/mcp/server.js";
import { ON_FILE, SHARED_FILE, sharedCheckText, sharedEnvelopes } from "../../../core/mcp/snapshot.js";
import { FIXTURES, FRESH } from "../../../core/test/harness/fixtures.js";

const SOURCE = new URL("../src-tauri/helpers/share.swift", import.meta.url);
const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const HELPER = new URL(`../src-tauri/binaries/ozzie-share-${triple}`, import.meta.url).pathname;

/** Why the helper can't be compared here, or null when it can: built, and carrying the script core/mcp builds today. */
async function unavailable(): Promise<string | null> {
  if (process.platform !== "darwin") return "ozzie-share is a Mac helper";
  if (!existsSync(HELPER)) return `ozzie-share isn't built (${HELPER}): run \`pnpm build:share\`, then \`cargo build\` in product/desktop/src-tauri`;
  const built = await build({ configFile: new URL("../../../core/mcp/vite.share.config.ts", import.meta.url).pathname, logLevel: "silent", build: { write: false, emptyOutDir: false } });
  const script = ((Array.isArray(built) ? built[0]! : built as Rollup.RollupOutput).output[0] as Rollup.OutputChunk).code;
  if (!readFileSync(HELPER).includes(Buffer.from(script, "utf8"))) return "ozzie-share is older than core/mcp: run `pnpm build:share`, then `cargo build` in product/desktop/src-tauri";
  return null;
}
const why = await unavailable();
if (why) console.warn(`Skipping the ozzie-share helper tests: ${why}`);

const skills = await bundledSkills();
const dirs: string[] = [];
const folder = () => { const d = mkdtempSync(join(tmpdir(), "ozzie-share-")); dirs.push(d); return d; };
/** A folder with sharing on (native's marker beside the copy), and where its copy goes. */
const sharing = () => { const dir = folder(); writeFileSync(join(dir, ON_FILE), "", { mode: 0o600 }); return { dir, path: join(dir, SHARED_FILE) }; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sharedText = async (data: HarnessData) =>
  sharedCheckText(await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => FRESH })), [], "2026-11-20T15:06:00Z", "B4K7Q2X9M3T8");

/** The helper over `input` (all of it, then end of input), with only these variables set. */
function helper(input: Buffer, env: Record<string, string>): Buffer {
  const run = spawnSync(HELPER, [], { input, env, timeout: 20_000, maxBuffer: 64 << 20 });
  expect(run.error).toBeUndefined();
  expect(run.status, run.stderr.toString()).toBe(0);
  expect(run.stderr.toString()).toBe("");
  return run.stdout;
}
/** The Node server over the same input, reading the file as file.ts does. */
async function node(input: Buffer, path: string): Promise<Buffer> {
  const stdin = new PassThrough(), stdout = new PassThrough(), out: Buffer[] = [];
  stdout.on("data", (c: Buffer) => out.push(c));
  const done = serveStream(new McpServer({ read: () => readShared(path), skills }), stdin, stdout);
  stdin.end(input);
  await done;
  return Buffer.concat(out);
}
async function same(input: Buffer, path: string, env: Record<string, string> = { OZZIE_SHARED_CHECK: path }, nodePath = path): Promise<string> {
  const ours = helper(input, env), theirs = await node(input, nodePath);
  expect(ours.toString("utf8")).toBe(theirs.toString("utf8"));
  expect(ours.equals(theirs)).toBe(true);
  return ours.toString("utf8");
}

const request = (id: number | string, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const callTool = (id: number, name: string) => request(id, "tools/call", { name });
const lines = (...l: (string | Buffer)[]) => Buffer.concat(l.map(x => Buffer.concat([typeof x === "string" ? Buffer.from(x, "utf8") : x, Buffer.from("\n")])));
/** A whole session: the handshake, every tool, errors, batches, a CRLF line, bytes that aren't UTF-8, a last line with no newline. */
const SESSION = Buffer.concat([lines(
  request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  request(2, "tools/list"),
  ...TOOLS.map((t, i) => callTool(10 + i, t.name)),
  request(20, "ping"), request(21, "resources/list"), callTool(22, "planning_center_refresh"), "{not json", "", "[]",
  `[${request(30, "ping")},${callTool(31, "church_rules")}]`, `[${Array.from({ length: MAX_BATCH + 1 }, (_, i) => request(40 + i, "ping")).join(",")}]`,
  `${request(50, "ping")}\r`,
  Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":"'), Buffer.from([0xff, 0xc3, 0x28, 0xe2, 0x82]), Buffer.from('","method":"ping"}')]),
), Buffer.from(callTool(60, "what_happened"))]);

describe.skipIf(why !== null)("ozzie-share answers as the Node server does, byte for byte", () => {
  it.each(FIXTURES)("%s: a whole session", async (_label, make) => {
    const { path } = sharing();
    writeFileSync(path, await sharedText(make()), { mode: 0o600 });
    const out = await same(SESSION, path);
    expect(out).toContain("From Ozzie's last saved check");
    expect(out).not.toContain(NOT_SHARED);
  });

  it("finds the file in Ozzie's data folder under HOME when OZZIE_SHARED_CHECK isn't set", async () => {
    const home = folder(), data = join(home, "Library", "Application Support", "church.ozzie.desktop");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, SHARED_FILE), await sharedText(FIXTURES[0]![1]()));
    writeFileSync(join(data, ON_FILE), "");
    expect(await same(lines(callTool(1, "sunday_readiness")), join(data, SHARED_FILE), { HOME: home })).toContain("From Ozzie's last saved check");
  });

  it("answers an over-long line once and skips through its newline, then carries on", async () => {
    const { path } = sharing();
    const input = Buffer.concat([Buffer.from("x".repeat(MAX_LINE + 10)), Buffer.from(`${request(7, "ping")}\n${request(8, "ping")}\n`),
      lines(`{"jsonrpc":"2.0","id":9,"method":"ping","pad":"${"x".repeat(MAX_LINE)}"}`, request(10, "ping")),
      Buffer.from("y".repeat(4 * MAX_LINE)), Buffer.from(`\n${request(11, "ping")}\n`), Buffer.from("z".repeat(MAX_LINE + 1))]);
    const out = await same(input, path);
    expect(out.split("\n").filter(Boolean).map(l => (JSON.parse(l) as { id: unknown }).id)).toEqual([null, 8, null, 10, null, 11, null]);
  });

  it("says the same thing, byte for byte, for sharing off, a missing, linked, oversized or tampered file, or one that isn't a file", async () => {
    const every = lines(...TOOLS.map((t, i) => callTool(i, t.name)));
    const { dir, path } = sharing();
    const nothing = await same(every, path);
    expect(nothing.split(NOT_SHARED).length - 1).toBe(TOOLS.length);
    const o = JSON.parse(await sharedText(FIXTURES[0]![1]())) as Record<string, unknown>;
    o["names"] = { 1: "Avery Example" };
    writeFileSync(path, JSON.stringify(o));
    expect(await same(every, path)).toBe(nothing);
    writeFileSync(join(dir, "real.json"), await sharedText(FIXTURES[0]![1]()));
    symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
    writeFileSync(join(dir, "big.json"), " ".repeat(300_000));
    writeFileSync(join(dir, "text.json"), "an ordinary file\n");
    for (const other of [join(dir, "link.json"), dir, join(dir, "big.json"), join(dir, "text.json"), join(dir, "missing.json")]) {
      expect(await same(every, other)).toBe(nothing);
    }
    expect(await same(every, join(dir, "real.json"))).toContain("From Ozzie's last saved check");
    // Sharing off: the copy is there, but native's marker beside it isn't a regular file, or isn't there at all.
    for (const off of [() => rmSync(join(dir, ON_FILE)), () => mkdirSync(join(dir, ON_FILE)), () => { rmSync(join(dir, ON_FILE), { recursive: true }); symlinkSync(join(dir, "text.json"), join(dir, ON_FILE)); }]) {
      off();
      expect(await same(every, join(dir, "real.json"))).toBe(nothing);
    }
  });

  it("answers copies with odd times as the Node server does: a leap second or a day the month lacks is refused in both", async () => {
    const { path } = sharing();
    const base = JSON.parse(await sharedText(FIXTURES[0]![1]())) as { envelopes: { check_time: string }[]; checked_at: string; shared_at: string };
    const odd: ((o: typeof base) => void)[] = [
      o => { for (const e of o.envelopes) e.check_time = "2026-11-20T15:00:60Z"; o.checked_at = "2026-11-20T15:01:00.000Z"; },
      o => { o.shared_at = "2026-02-30T15:06:00Z"; }, o => { o.shared_at = "2026-02-29T15:06:00Z"; }, o => { o.shared_at = "2028-02-29T15:06:00Z"; },
      o => { o.shared_at = "2026-11-20T24:00:00Z"; },
    ];
    const answers = [];
    for (const change of odd) {
      const o = structuredClone(base);
      change(o);
      writeFileSync(path, JSON.stringify(o));
      answers.push(await same(lines(callTool(1, "sunday_readiness"), callTool(2, "what_happened")), path));
    }
    expect(answers.map(a => a.includes(NOT_SHARED))).toEqual([true, true, true, false, true]);
  });

  it("trims the file's path as Node's String.prototype.trim does", async () => {
    const { path } = sharing();
    writeFileSync(path, await sharedText(FIXTURES[0]![1]()));
    for (const [value, found] of [[`\uFEFF ${path}\u2028`, true], [`${path}\u0085`, false]] as const) {
      const out = await same(lines(callTool(1, "sunday_readiness")), path, { OZZIE_SHARED_CHECK: value }, sharedCheckPath({ OZZIE_SHARED_CHECK: value }));
      expect(out.includes(NOT_SHARED)).toBe(!found);
    }
  });

  it("doesn't wait on a named pipe put where the file should be: it reads as no file, at once", async () => {
    const { path } = sharing();
    spawnSync("mkfifo", [path]);
    const started = Date.now();
    expect(await same(lines(callTool(1, "sunday_readiness")), path)).toContain(NOT_SHARED);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reads the file and the marker again on every call, and writes nothing anywhere", async () => {
    const { dir, path } = sharing();
    const child = spawn(HELPER, [], { env: { OZZIE_SHARED_CHECK: path, HOME: dir }, cwd: dir });
    let out = "", waiting: ((line: string) => void) | null = null;
    const flush = () => {
      const at = out.indexOf("\n");
      if (!waiting || at < 0) return;
      const resolve = waiting;
      waiting = null;
      resolve(out.slice(0, at));
      out = out.slice(at + 1);
    };
    child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); flush(); });
    const next = () => new Promise<string>(resolve => { waiting = resolve; flush(); });
    child.stdin.write(`${callTool(1, "sunday_readiness")}\n`);
    expect(await next()).toContain(NOT_SHARED);
    writeFileSync(path, await sharedText(FIXTURES[0]![1]()));
    let before = readdirSync(dir).sort();
    child.stdin.write(`${callTool(2, "sunday_readiness")}\n`);
    expect(await next()).toContain("From Ozzie's last saved check");
    expect(readdirSync(dir).sort()).toEqual(before);
    // Sharing turned off while the copy couldn't be removed: nothing more is shown.
    rmSync(join(dir, ON_FILE));
    before = readdirSync(dir).sort();
    child.stdin.write(`${callTool(3, "sunday_readiness")}\n`);
    expect(await next()).toContain(NOT_SHARED);
    child.stdin.end();
    expect(await new Promise(resolve => child.on("exit", resolve))).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("waits, rather than stops or cuts a reply short, when its stdin or stdout doesn't block", async () => {
    const { dir, path } = sharing();
    writeFileSync(path, await sharedText(FIXTURES[0]![1]()));
    const batch = `[${Array.from({ length: MAX_BATCH }, (_, i) => callTool(100 + i, "sunday_readiness")).join(",")}]`;
    const input = lines(request(1, "ping"), batch, batch, request(2, "ping"));
    // stdout: a named pipe read only after a pause, so it fills; stdin: written only after a pause, so it starts empty.
    // Perl makes both ends non-blocking for the helper (Node hands a child blocking ones), then runs it.
    const fifo = join(dir, "out");
    spawnSync("mkfifo", [fifo]);
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK), writer = openSync(fifo, constants.O_WRONLY);
    const child = spawn("/usr/bin/perl", ["-e", "use Fcntl; for my $fh (*STDIN, *STDOUT) { fcntl($fh, F_SETFL, fcntl($fh, F_GETFL, 0) | O_NONBLOCK) or die } exec { $ARGV[0] } @ARGV or die", HELPER],
      { stdio: ["pipe", writer, "inherit"], env: { OZZIE_SHARED_CHECK: path } });
    closeSync(writer);
    const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
    await pause(300);
    child.stdin!.end(input);
    await pause(500);
    const out: Buffer[] = [];
    for (const chunk = Buffer.alloc(1 << 16); ;) {
      let n: number;
      try { n = readSync(reader, chunk, 0, chunk.length, null); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error; await pause(5); continue; }
      if (n === 0) break;
      out.push(Buffer.from(chunk.subarray(0, n)));
    }
    closeSync(reader);
    expect(await new Promise(resolve => child.exitCode !== null ? resolve(child.exitCode) : child.on("exit", resolve))).toBe(0);
    const ours = Buffer.concat(out), theirs = await node(input, path);
    expect(theirs.length).toBeGreaterThan(1 << 17);
    expect(ours.toString("utf8")).toBe(theirs.toString("utf8"));
  });

  it("takes no arguments", () => {
    const run = spawnSync(HELPER, ["--anything"], { input: lines(request(1, "ping")), env: {} });
    expect(run.status).toBe(64);
    expect(run.stdout.length).toBe(0);
  });
});

describe("ozzie-share's source", () => {
  it("holds no network, process or file-writing call, and reads only the shared file and stdin", () => {
    const src = readFileSync(SOURCE, "utf8");
    expect(src).not.toMatch(/URLSession|NSURL|CFNetwork|Network\b|socket\(|connect\(|getaddrinfo|Process\(|NSTask|posix_spawn|fork\(|exec[lv]p?\(|system\(|popen\(/u);
    expect(src).not.toMatch(/O_WRONLY|O_RDWR|O_CREAT|O_APPEND|fopen\(|FileManager|createFile|\.write\(to|unlink\(|rename\(|mkdir\(|truncate\(|chmod\(/u);
    // One open, of the shared file (read-only, no link, no waiting); stdin is read as given; writes go only to stdout
    // (and a startup failure to stderr).
    expect([...src.matchAll(/\bopen\(([^)]*)\)/gu)].map(m => m[1])).toEqual(["path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC"]);
    expect([...src.matchAll(/Darwin\.write\((\w+)/gu)].map(m => m[1])).toEqual(["1"]);
    expect(src).toMatch(/import JavaScriptCore/u);
    expect([...src.matchAll(/^import (\w+)/gmu)].map(m => m[1]).sort()).toEqual(["Darwin", "Foundation", "JavaScriptCore", "MachO"]);
  });
});
