// Ozzie's read-only server for other AI apps (harness plan H5): the protocol handshake, every tool's words over every
// kind of check the harness fixtures hold (no name, place name, typed reason or contact detail; the "capitalized
// only" name rule), the file refused whole when anything in it is off, and nothing written anywhere.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { hasContactDetail } from "../../src/ask.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import type { Skill, ToolEnvelope } from "../../src/harness/contract.js";
import { namedIn } from "../../src/harness/names.js";
import { HarnessSession, showTimes } from "../../src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../src/harness/tools.js";
import { readShared, sharedCheckPath } from "../../mcp/file.js";
import { NOT_SHARED } from "../../mcp/render.js";
import { INSTRUCTIONS, MAX_BATCH, MAX_LINE, McpServer, PROTOCOL_VERSIONS, serveStream, TOOLS, type Response } from "../../mcp/server.js";
import { checkedAtOf, ON_FILE, parseSharedCheck, SHARED_TOOLS, sharedCheckText, sharedEnvelopes, type SharedTask } from "../../mcp/snapshot.js";
import { FIXTURES, FRESH, harnessData, sourceStrings } from "../harness/fixtures.js";

const skills: ReadonlyMap<string, Skill> = await bundledSkills();
const SHARED_AT = "2026-11-20T15:06:00Z";
const COPY = "B4K7Q2X9M3T8";
const TASKS: SharedTask[] = [
  { kind: "check", skill_id: "sunday-ready", state: "verified", created_at: "2026-11-20T15:00:00Z", updated_at: "2026-11-20T15:00:04Z", failure: null,
    events: [{ type: "admitted", detail: "", at: "2026-11-20T15:00:00Z" }, { type: "running", detail: "", at: "2026-11-20T15:00:00Z" },
      { type: "tool", detail: "sunday.overview complete", at: "2026-11-20T15:00:02Z" }, { type: "verified", detail: "", at: "2026-11-20T15:00:04Z" }] },
  { kind: "ask", skill_id: "answer-from-what-was-read", state: "failed", created_at: "2026-11-20T14:50:00Z", updated_at: "2026-11-20T14:50:09Z", failure: "egress",
    events: [{ type: "model", detail: "1", at: "2026-11-20T14:50:01Z" }, { type: "model", detail: "1 egress", at: "2026-11-20T14:50:02Z" },
      { type: "failed", detail: "egress", at: "2026-11-20T14:50:09Z" }] },
  { kind: "skill", skill_id: "room-check", state: "cancelled", created_at: "2026-11-20T14:40:00Z", updated_at: "2026-11-20T14:40:03Z", failure: null, events: [] },
];

async function sharedFor(data: HarnessData): Promise<{ envelopes: ToolEnvelope[]; text: string }> {
  const envelopes = await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => FRESH }));
  return { envelopes, text: sharedCheckText(envelopes, TASKS, SHARED_AT, COPY) };
}
const serverOver = (read: () => string | null) => new McpServer({ read, skills });
const call = (server: McpServer, name: string, args: unknown = {}, id = 9) => server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) as Response;
const textOf = (r: Response): string => {
  if (!("result" in r)) throw new Error(`error ${JSON.stringify(r.error)}`);
  return ((r.result as { content: { text: string }[] }).content).map(c => c.text).join("\n");
};
const allText = (server: McpServer) => TOOLS.map(t => textOf(call(server, t.name))).join("\n");

describe("the protocol", () => {
  const server = serverOver(() => null);

  it("answers initialize with its tools capability, agreeing on the client's version when it knows it", () => {
    const r = server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(r).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ozzie-last-check" } } });
    const other = server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(other).toMatchObject({ result: { protocolVersion: PROTOCOL_VERSIONS[0] } });
    // Nothing but tools: no resources, prompts, sampling or logging.
    expect(Object.keys((r as { result: { capabilities: object } }).result.capabilities)).toEqual(["tools"]);
  });

  it("never answers a notification, and answers ping, unknown methods and bad input with JSON-RPC errors", () => {
    expect(server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).toBeNull();
    expect(server.handle({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    for (const method of ["resources/list", "prompts/list", "sampling/createMessage", "tools/write"]) {
      expect(server.handle({ jsonrpc: "2.0", id: 4, method })).toMatchObject({ id: 4, error: { code: -32601 } });
    }
    expect(JSON.parse(server.line("{not json")!)).toMatchObject({ id: null, error: { code: -32700 } });
    expect(server.handle({ jsonrpc: "1.0", id: 5, method: "ping" })).toMatchObject({ id: 5, error: { code: -32600 } });
    expect(server.handle({ jsonrpc: "2.0", id: { no: 1 }, method: "ping" })).toMatchObject({ id: null, error: { code: -32600 } });
    expect(server.line("")).toBeNull();
  });

  it("lists four tools that take no arguments and are all marked read-only, closed-world and not destructive", () => {
    const r = server.handle({ jsonrpc: "2.0", id: 6, method: "tools/list" }) as { result: { tools: Record<string, unknown>[] } };
    expect(r.result.tools.map(t => t["name"])).toEqual(["sunday_readiness", "rooms_follow_ups_groups", "church_rules", "what_happened"]);
    for (const t of r.result.tools) {
      expect(t["inputSchema"]).toEqual({ type: "object", properties: {}, additionalProperties: false });
      expect(t["annotations"]).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
  });

  it("refuses an unknown tool and any argument", () => {
    expect(call(server, "drafts_prepare_note")).toMatchObject({ error: { code: -32602 } });
    expect(call(server, "planning_center_refresh")).toMatchObject({ error: { code: -32602 } });
    expect(call(server, "sunday_readiness", { plan: "1" })).toMatchObject({ result: { isError: true } });
    expect(call(server, "sunday_readiness", ["x"])).toMatchObject({ result: { isError: true } });
    expect(call(server, "sunday_readiness", null)).toMatchObject({ result: { isError: false } });
  });

  it("serves a whole session over a stream, one line per response and nothing else on the output", async () => {
    const { text } = await sharedFor(harnessData());
    const input = new PassThrough(), output = new PassThrough();
    let written = "";
    output.on("data", (c: Buffer) => { written += c.toString("utf8"); });
    const done = serveStream(serverOver(() => text), input, output);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\r\n`);
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    input.write(list.slice(0, 10));
    input.write(`${list.slice(10)}\n`);
    input.end(JSON.stringify({ jsonrpc: "2.0", id: "c", method: "tools/call", params: { name: "sunday_readiness", arguments: {} } }));
    await done;
    const lines = written.split("\n").filter(Boolean).map(l => JSON.parse(l) as Response);
    expect(lines.map(l => l.id)).toEqual([1, 2, "c"]);
    expect(textOf(lines[2]!)).toContain("From Ozzie's last saved check");
  });

  const session = async (chunks: string[], server = serverOver(() => null)) => {
    const input = new PassThrough(), output = new PassThrough();
    let written = "";
    output.on("data", (c: Buffer) => { written += c.toString("utf8"); });
    const done = serveStream(server, input, output);
    for (const c of chunks) input.write(c);
    input.end();
    await done;
    return written.split("\n").filter(Boolean).map(l => JSON.parse(l) as Response | Response[]);
  };
  const ping = (id: number, extra = "") => `{"jsonrpc":"2.0","id":${id},"method":"ping"${extra}}`;

  it("drops an over-long line through its newline without reading any of it, then carries on", async () => {
    // Too long before its newline arrives: the rest of that line (here a whole ping) is never read.
    const split = await session(["x".repeat(MAX_LINE + 10), `${ping(7)}\n${ping(8)}\n`]);
    expect(split).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, { jsonrpc: "2.0", id: 8, result: {} }]);
    // Too long with its newline in the same chunk: refused before it's parsed, though it is valid JSON.
    const whole = await session([`${ping(9, `,"pad":"${"x".repeat(MAX_LINE)}"`)}\n${ping(10)}\n`]);
    expect(whole).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, { jsonrpc: "2.0", id: 10, result: {} }]);
    // And over several chunks, said once.
    const many = await session(["x".repeat(MAX_LINE), "x".repeat(MAX_LINE), "x\n", `${ping(11)}\n`]);
    expect(many.map(r => (r as Response).id)).toEqual([null, 11]);
    expect(serverOver(() => null).line(ping(12, `,"pad":"${"x".repeat(MAX_LINE)}"`))).toBe(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }));
  });

  it("answers a batch of up to MAX_BATCH requests, and refuses a larger one whole", () => {
    const server = serverOver(() => null);
    const batch = (n: number) => `[${Array.from({ length: n }, (_, i) => ping(i + 1)).join(",")}]`;
    expect((JSON.parse(server.line(batch(MAX_BATCH))!) as Response[]).map(r => r.id)).toEqual(Array.from({ length: MAX_BATCH }, (_, i) => i + 1));
    expect(JSON.parse(server.line(batch(MAX_BATCH + 1))!)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  });

  it("answers a tool that fails with a JSON-RPC error, and keeps serving", async () => {
    const broken = new Map([["x", { get title(): string { throw new Error("boom"); }, purpose: "" } as unknown as Skill]]);
    const server = new McpServer({ read: () => null, skills: broken });
    expect(call(server, "church_rules", {}, 21)).toEqual({ jsonrpc: "2.0", id: 21, error: { code: -32603, message: "Internal error" } });
    const lines = await session([`${JSON.stringify({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "church_rules" } })}\n${ping(23)}\n`], server);
    expect(lines.map(r => (r as Response).id)).toEqual([22, 23]);
  });

  it("stops reading while the client isn't taking what it wrote, and reads on once it does", async () => {
    const input = new PassThrough(), output = new PassThrough({ highWaterMark: 1 });
    const done = serveStream(serverOver(() => null), input, output);
    input.write(`${ping(1)}\n`);
    await new Promise(r => setImmediate(r));
    expect(input.isPaused()).toBe(true);
    output.resume();
    await new Promise(r => setImmediate(r));
    expect(input.isPaused()).toBe(false);
    input.end();
    await done;
  });
});

describe("every tool's words, over every kind of check", () => {
  it.each(FIXTURES)("%s: no name, place name, position name, typed reason or contact detail; every fact from the check", async (_label, make) => {
    const data = make();
    const { envelopes, text } = await sharedFor(data);
    expect(parseSharedCheck(text)).not.toBeNull();
    expect(envelopes.map(e => e.tool)).toEqual(SHARED_TOOLS.filter(t => envelopes.some(e => e.tool === t)));
    const out = allText(serverOver(() => text));
    // The "capitalized only" rule (names.ts, the default), and the strict rule too: a name part in any case.
    expect(namedIn(out, data.capture!.names, "capitalized-common-words")).toBe(false);
    expect(namedIn(out, data.capture!.names, "strict")).toBe(false);
    for (const s of sourceStrings(data)) expect(out, s).not.toContain(s);
    expect(out).not.toMatch(/canary/iu);
    expect(hasContactDetail(out)).toBe(false);
    expect(out).not.toContain(NOT_SHARED);
  });

  it("says where Sunday stands in Ozzie's sentences, with labels, sources and check times written out", async () => {
    const { text } = await sharedFor(harnessData({ mode: "live" }));
    const out = textOf(call(serverOver(() => text), "sunday_readiness"));
    expect(out).toContain("## Overview (from Planning Center Services, checked ");
    expect(out).toMatch(/\[Role \d+\]/u);
    expect(out).toMatch(/\[Person \d+\]/u);
    expect(out).toContain("Pending is not the same as asked.");
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    // Fact ids and raw JSON stay inside: the words are Ozzie's own.
    expect(out).not.toMatch(/"fact"|\bf\d+\b/u);
  });

  it("says when the facts were checked (not when the copy was saved), which copy it is, and that labels hold only within it", async () => {
    const { envelopes, text } = await sharedFor(harnessData({ mode: "live" }));
    const checked = checkedAtOf(envelopes)!;
    expect(Date.parse(checked)).toBe(Math.min(...envelopes.map(e => Date.parse(e.check_time))));
    expect(Date.parse(checked)).toBeLessThan(Date.parse(SHARED_AT));
    expect(parseSharedCheck(text)).toMatchObject({ checked_at: checked, shared_at: SHARED_AT, copy_id: COPY });
    const server = serverOver(() => text);
    for (const name of ["sunday_readiness", "rooms_follow_ups_groups", "church_rules"]) {
      const out = textOf(call(server, name));
      expect(out, name).toContain(`From Ozzie's last saved check, checked ${showTimes(checked, null)} (copy ${COPY}).`);
      expect(out, name).not.toContain(showTimes(SHARED_AT, null));
      expect(out, name).toContain(`A label means the same thing only within this copy (copy ${COPY}); in another copy the same label may refer to a different person, role or room.`);
    }
    expect(textOf(call(server, "what_happened"))).toContain(`copy ${COPY}`);
    expect(INSTRUCTIONS).toContain("Labels such as [Person 1] are only meaningful within one copy of the check");
  });

  it("says a saved copy of a check is a past check", async () => {
    const { text } = await sharedFor(harnessData({ mode: "recording" }));
    expect(textOf(call(serverOver(() => text), "sunday_readiness"))).toContain("This check is out of date, or it is a saved copy of a check.");
  });

  it("gives the Church rules in words and the procedures Ozzie follows", async () => {
    const { text } = await sharedFor(harnessData());
    const out = textOf(call(serverOver(() => text), "church_rules"));
    expect(out).toContain("Your Church rules suggest a check-in after 3 Sundays in a row.");
    expect(out).toMatch(/\[Room \d+\] isn't shared, with 15 minutes of setup time\./u);
    for (const s of skills.values()) expect(out).toContain(`- ${s.title}: ${s.purpose}`);
  });

  it("says what happened from the task record only: kinds, outcomes and what was looked at, never ids", async () => {
    const { text } = await sharedFor(harnessData());
    const out = textOf(call(serverOver(() => text), "what_happened"));
    expect(out).toContain("A Sunday check of Planning Center. Finished. It looked at the Sunday overview.");
    expect(out).toContain("A question asked in Ozzie (the question itself is never kept). Didn't finish: a safety check stopped a message before it left the Mac. It used 1 AI step.");
    expect(out).toContain(`Ozzie's "${skills.get("room-check")!.title}" procedure. Stopped by a person.`);
    expect(out).not.toMatch(/sunday-ready|answer-from-what-was-read|[0-9a-f]{8}-[0-9a-f]{4}/u);
  });

  it("with nothing shared, every tool says so plainly, without urging anyone to turn sharing on", () => {
    const server = serverOver(() => null);
    for (const t of TOOLS) expect(textOf(call(server, t.name))).toContain(NOT_SHARED);
    expect(NOT_SHARED).toContain("sharing is off in Ozzie");
    expect(NOT_SHARED).not.toMatch(/turn (?:it |sharing )?on|open settings|check sunday/iu);
  });
});

describe("the shared file is refused whole when anything in it is off", () => {
  const tamper = async (change: (o: Record<string, unknown>) => void) => {
    const { text } = await sharedFor(harnessData());
    const o = JSON.parse(text) as Record<string, unknown>;
    change(o);
    return JSON.stringify(o);
  };
  const envelopes = (o: Record<string, unknown>) => o["envelopes"] as ToolEnvelope[];
  const payload = (o: Record<string, unknown>, i = 0) => envelopes(o)[i]!.payload as Record<string, unknown>;
  const cases: [string, (o: Record<string, unknown>) => void][] = [
    ["a name in place of a label", o => { const p = payload(o, 1); const needs = p["needs"] as Record<string, unknown>[]; needs[0]!["role"] = "Avery Example"; }],
    ["a name as a fixed sentence", o => { (payload(o, 4)["services"] as string[]).push("Avery Example couldn't be checked."); }],
    ["a phone number in a count's place", o => { payload(o)["sunday"] = "555-201-3344"; }],
    ["a key outside the vocabulary", o => { payload(o)["note"] = "worth a look"; }],
    ["an envelope from a tool that isn't shared", o => { envelopes(o)[0]!.tool = "sunday.who_could_help"; }],
    ["the same tool twice", o => { envelopes(o).push(envelopes(o)[0]!); }],
    ["a source that isn't Ozzie's", o => { envelopes(o)[0]!.source = "Avery's notes"; }],
    ["another format", o => { o["format"] = "ozzie-shared-check-3"; }],
    ["the first format, which had no check time or copy", o => { o["format"] = "ozzie-shared-check-1"; delete o["checked_at"]; delete o["copy_id"]; }],
    ["a check time later than the check", o => { o["checked_at"] = SHARED_AT; }],
    ["a check time earlier than the check", o => { o["checked_at"] = "2026-11-19T15:00:00.000Z"; }],
    ["no check time", o => { delete o["checked_at"]; }],
    ["a copy id outside its shape", o => { o["copy_id"] = "Avery"; }],
    ["a copy id with a phone number in it", o => { o["copy_id"] = "5552013344AB"; }],
    ["no results at all", o => { o["envelopes"] = []; }],
    ["an extra field", o => { o["names"] = { 1: "Avery Example" }; }],
    ["a task with text", o => { (o["tasks"] as Record<string, unknown>[])[0]!["question"] = "Is Avery free?"; }],
    ["a task event outside the ledger grammar", o => { ((o["tasks"] as SharedTask[])[0]!.events[2]!).detail = "Avery Example"; }],
    ["a task with an unknown failure", o => { (o["tasks"] as SharedTask[])[1]!.failure = "avery"; }],
    // Times are checked part by part, the same in every JavaScript engine: no leap second, no day a month doesn't have.
    ["a leap second", o => { for (const e of envelopes(o)) e.check_time = "2026-11-20T15:00:60Z"; o["checked_at"] = "2026-11-20T15:01:00.000Z"; }],
    ["a save time on February 30", o => { o["shared_at"] = "2026-02-30T15:06:00Z"; }],
    ["a save time on February 29 of a year without one", o => { o["shared_at"] = "2026-02-29T15:06:00Z"; }],
    ["a task on April 31", o => { (o["tasks"] as SharedTask[])[0]!.created_at = "2026-04-31T15:00:00Z"; }],
    ["an hour of 24", o => { (o["tasks"] as SharedTask[])[0]!.updated_at = "2026-11-20T24:00:00Z"; }],
    ["an offset of 24 hours", o => { (o["tasks"] as SharedTask[])[0]!.events[0]!.at = "2026-11-20T15:00:00+24:00"; }],
    ["a time in a fixed sentence on February 30", o => { (payload(o, 4)["services"] as string[]).push("2026-02-30"); }],
    // Background-check wording that fixed words can still spell never goes to another AI app (owner decision 2026-11-14;
    // review B L3), even when the grammar lets it through.
    ["background-check wording in fixed words", o => { (payload(o, 4)["services"] as string[]).push("The check is out of date."); }],
    ["records check in fixed words", o => { (payload(o, 4)["services"] as string[]).push("Some records check out."); }],
  ];
  it.each(cases)("%s", async (_label, change) => {
    const text = await tamper(change);
    expect(parseSharedCheck(text)).toBeNull();
    const out = allText(serverOver(() => text));
    // Refused whole, and said exactly as when nothing is shared: a file that isn't Ozzie's tells the other app nothing.
    expect(out).toBe(allText(serverOver(() => null)));
    expect(out).not.toMatch(/Avery|555/u);
  });
  it("Ozzie's own out-of-date line, exactly as it writes it, is still shared", async () => {
    const own = "Rooms, follow-ups and group meetings: this check is out of date, so they aren't shown.";
    expect(parseSharedCheck(await tamper(o => { (payload(o, 4)["services"] as string[]).push(own); }))).not.toBeNull();
  });
  it("a real February 29 is a real date", async () => {
    expect(parseSharedCheck(await tamper(o => { o["shared_at"] = "2028-02-29T15:06:00Z"; }))).not.toBeNull();
  });
  it("not JSON, or too large", () => {
    expect(parseSharedCheck("{")).toBeNull();
    expect(parseSharedCheck(" ".repeat(300_000))).toBeNull();
  });
});

describe("read-only", () => {
  it("reads the file without writing anything: the folder and the file are exactly as they were", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ozzie-mcp-"));
    try {
      const file = join(dir, "shared-check.json");
      const { text } = await sharedFor(harnessData());
      writeFileSync(file, text, { mode: 0o600 });
      writeFileSync(join(dir, ON_FILE), "", { mode: 0o600 });
      const before = { list: readdirSync(dir), mtime: statSync(file).mtimeMs, mode: statSync(file).mode, bytes: readFileSync(file, "utf8") };
      const server = serverOver(() => readShared(file));
      const out = allText(server);
      expect(out).not.toContain(NOT_SHARED);
      expect({ list: readdirSync(dir), mtime: statSync(file).mtimeMs, mode: statSync(file).mode, bytes: readFileSync(file, "utf8") }).toEqual(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads no link, folder or missing file, and finds the app's folder on a Mac", () => {
    const dir = mkdtempSync(join(tmpdir(), "ozzie-mcp-"));
    try {
      writeFileSync(join(dir, "real.json"), "{}");
      writeFileSync(join(dir, ON_FILE), "");
      symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
      expect(readShared(join(dir, "real.json"))).toBe("{}");
      expect(readShared(join(dir, "link.json"))).toBeNull();
      expect(readShared(dir)).toBeNull();
      expect(readShared(join(dir, "missing.json"))).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(sharedCheckPath({ OZZIE_SHARED_CHECK: "/x/y.json" })).toBe("/x/y.json");
    // String.prototype.trim's white space, which the helper matches: a byte-order mark goes, a next-line mark stays.
    expect(sharedCheckPath({ OZZIE_SHARED_CHECK: "\uFEFF /x/y.json\u2028" })).toBe("/x/y.json");
    expect(sharedCheckPath({ OZZIE_SHARED_CHECK: "/x/y.json\u0085" })).toBe("/x/y.json\u0085");
    expect(sharedCheckPath({})).toMatch(/Library\/Application Support\/church\.ozzie\.desktop\/shared-check\.json$/u);
  });

  it("doesn't wait on a named pipe put where the file should be: it reads as no file, at once", () => {
    const dir = mkdtempSync(join(tmpdir(), "ozzie-mcp-"));
    try {
      const fifo = join(dir, "shared-check.json");
      writeFileSync(join(dir, ON_FILE), "");
      execFileSync("mkfifo", [fifo]);
      const started = Date.now();
      expect(readShared(fifo)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads the copy only while sharing is on: the marker native keeps beside it must be a regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ozzie-mcp-"));
    try {
      const file = join(dir, "shared-check.json"), marker = join(dir, ON_FILE);
      writeFileSync(file, "{}");
      expect(readShared(file)).toBeNull();
      mkdirSync(marker);
      expect(readShared(file)).toBeNull();
      rmSync(marker, { recursive: true });
      writeFileSync(join(dir, "elsewhere"), "");
      symlinkSync(join(dir, "elsewhere"), marker);
      expect(readShared(file)).toBeNull();
      rmSync(marker);
      writeFileSync(marker, "");
      expect(readShared(file)).toBe("{}");
      // Sharing turned off while the copy couldn't be removed: nothing is read.
      rmSync(marker);
      expect(readShared(file)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // The marker's name is native's (shared_check.rs ON_FILE).
    const native = readFileSync(new URL("../../native-auth/src/shared_check.rs", import.meta.url), "utf8");
    expect(native).toContain(`pub const ON_FILE: &str = "${ON_FILE}";`);
  });

  it("holds no write, network or process call anywhere in its source", () => {
    const dir = new URL("../../mcp/", import.meta.url);
    const sources = readdirSync(dir).filter(f => f.endsWith(".ts") && !/^vite(?:\.\w+)?\.config\.ts$/u.test(f));
    expect(sources.sort()).toEqual(["embedded.ts", "file.ts", "main.ts", "render.ts", "server.ts", "setup.ts", "shortcuts-embedded.ts", "shortcuts.ts", "snapshot.ts"]);
    for (const f of sources) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/\b(?:writeFile|writeSync|appendFile|createWriteStream|mkdir|rmSync|unlink|rename|copyFile|truncate|chmod|O_WRONLY|O_RDWR|O_CREAT)\b/u);
      expect(src, f).not.toMatch(/\bfetch\(|node:(?:http|https|net|dgram|tls|child_process|worker_threads)|XMLHttpRequest|WebSocket/u);
      const imports = [...src.matchAll(/from "([^"]+)"/gu)].map(m => m[1]!);
      for (const i of imports) expect(i, `${f} imports ${i}`).toMatch(/^(?:\.\/|\.\.\/src\/|node:(?:fs|os|path)$)/u);
    }
  });
});
