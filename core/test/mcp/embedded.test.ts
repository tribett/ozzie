// The server as Ozzie's bundled helper runs it (core/mcp/embedded.ts in the Mac's JavaScriptCore, no Node): every
// answer the same as the Node server's over every harness fixture, the built script working with nothing in its global
// object but JavaScript, and no background-check wording or fact in anything any tool says.
import { createContext, runInContext } from "node:vm";
import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import type { Skill } from "../../src/harness/contract.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../src/harness/tools.js";
import { createServer, MAX_SHARED_BYTES as EMBEDDED_MAX_SHARED, MAX_LINE as EMBEDDED_MAX_LINE, ON_FILE as EMBEDDED_ON, procedures, SHARED_FILE as EMBEDDED_FILE } from "../../mcp/embedded.js";
import { MAX_BATCH, MAX_LINE, McpServer, TOOLS } from "../../mcp/server.js";
import { envelopeProblems, isIsoTime, isoMillis, sentenceFits } from "../../src/harness/fixed.js";
import { MAX_SHARED_BYTES, ON_FILE, parseSharedCheck, SHARED_FILE, sharedCheckText, sharedEnvelopes, type SharedTask } from "../../mcp/snapshot.js";
import { FIXTURES, FRESH } from "../harness/fixtures.js";
import { sundayShownCount } from "../../src/sunday-brief.js";
import { applyDecisions } from "../../src/sunday-decisions.js";

const skills: ReadonlyMap<string, Skill> = await bundledSkills();
const COPY = "B4K7Q2X9M3T8";
const TASKS: SharedTask[] = [
  { kind: "check", skill_id: "sunday-ready", state: "verified", created_at: "2026-11-20T15:00:00Z", updated_at: "2026-11-20T15:00:04Z", failure: null,
    events: [{ type: "tool", detail: "sunday.overview complete", at: "2026-11-20T15:00:02Z" }, { type: "verified", detail: "", at: "2026-11-20T15:00:04Z" }] },
  { kind: "skill", skill_id: "room-check", state: "failed", created_at: "2026-11-20T14:40:00Z", updated_at: "2026-11-20T14:40:03Z", failure: "timeout", events: [] },
];
const sharedText = async (data: HarnessData) =>
  sharedCheckText(await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => FRESH })), TASKS, "2026-11-20T15:06:00Z", COPY);

const request = (id: number | string, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const callTool = (id: number, name: string, args?: unknown) => request(id, "tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });
/** Every kind of line a client can send: the handshake, every tool, errors, notifications, batches, too long. */
const LINES: readonly string[] = [
  request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }),
  request(2, "initialize", { protocolVersion: "1999-01-01" }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  request(3, "tools/list"),
  ...TOOLS.map((t, i) => callTool(10 + i, t.name)),
  callTool(20, "sunday_readiness", { plan: "1" }), callTool(21, "drafts_prepare_note"), request(22, "ping"), request("s", "resources/list"),
  `[${request(30, "ping")},${callTool(31, "what_happened")}]`, `[${Array.from({ length: MAX_BATCH + 1 }, (_, i) => request(40 + i, "ping")).join(",")}]`, "[]",
  "{not json", "", "   ", JSON.stringify({ jsonrpc: "1.0", id: 5, method: "ping" }), `{"jsonrpc":"2.0","id":6,"method":"ping","pad":"${"x".repeat(MAX_LINE)}"}`,
];

describe("the embedded entry answers exactly as the Node server does", () => {
  it("takes its limits and file name from the server's own", () => {
    expect([EMBEDDED_MAX_LINE, EMBEDDED_MAX_SHARED, EMBEDDED_FILE, EMBEDDED_ON]).toEqual([MAX_LINE, MAX_SHARED_BYTES, SHARED_FILE, ON_FILE]);
  });

  it("knows the same procedures, checked the same way", () => {
    const strip = (m: ReadonlyMap<string, Skill>) => [...m.values()].map(s => [s.id, s.title, s.purpose, s.tools, s.needs, s.runs, s.body]);
    expect(strip(procedures())).toEqual(strip(skills));
  });

  it.each([["no shared check", null as HarnessData | null], ...FIXTURES.map(([label, make]) => [label, make()] as [string, HarnessData])])(
    "%s: every line answered byte for byte the same", async (_label, data) => {
      const text = data ? await sharedText(data) : null;
      if (text) expect(parseSharedCheck(text)).not.toBeNull();
      const node = new McpServer({ read: () => text, skills });
      const embedded = createServer(() => text);
      for (const line of LINES) expect(embedded(line), line.slice(0, 80)).toBe(node.line(line));
    });

  it("reads anything but a string from its host as no file, and reads again on every call", () => {
    let given: unknown = undefined;
    const embedded = createServer(() => given);
    const node = new McpServer({ read: () => null, skills });
    for (const value of [undefined, 7, {}, null]) { given = value; expect(embedded(callTool(1, "sunday_readiness"))).toBe(node.line(callTool(1, "sunday_readiness"))); }
    given = "{";
    expect(embedded(callTool(1, "sunday_readiness"))).toBe(node.line(callTool(1, "sunday_readiness")));
  });

  it("answers files with odd times exactly as the Node server does", async () => {
    for (const text of await oddTimes()) {
      const node = new McpServer({ read: () => text, skills }), embedded = createServer(() => text);
      for (const line of LINES) expect(embedded(line), line.slice(0, 80)).toBe(node.line(line));
    }
  });
});

/** A fixture's copy with one time changed: refused (leap second, impossible days, hour 24, offset 24) or kept (a real February 29). */
async function oddTimes(): Promise<string[]> {
  const base = JSON.parse(await sharedText(FIXTURES[0]![1]())) as Record<string, unknown> & { envelopes: { check_time: string }[]; tasks: SharedTask[] };
  const changed = (change: (o: typeof base) => void) => { const o = structuredClone(base); change(o); return JSON.stringify(o); };
  return [
    changed(o => { for (const e of o.envelopes) e.check_time = "2026-11-20T15:00:60Z"; o["checked_at"] = "2026-11-20T15:01:00.000Z"; }),
    changed(o => { o["shared_at"] = "2026-02-30T15:06:00Z"; }),
    changed(o => { o["shared_at"] = "2026-02-29T15:06:00Z"; }),
    changed(o => { o["shared_at"] = "2028-02-29T15:06:00Z"; }),
    changed(o => { o.tasks[0]!.created_at = "2026-04-31T15:00:00Z"; }),
    changed(o => { o.tasks[0]!.updated_at = "2026-11-20T24:00:00Z"; }),
    changed(o => { o.tasks[0]!.events[0]!.at = "2026-11-20T15:00:00+24:00"; }),
  ];
}

describe("times are checked part by part, the same in every JavaScript engine", () => {
  // V8 (Node) and JavaScriptCore (the helper) disagree on Date.parse for these: a leap second, a day the month lacks.
  const VALID = ["2026-11-20T15:00Z", "2026-11-20T15:00:00Z", "2026-11-20T15:00:00.5Z", "2026-11-20T15:00:00.123Z", "2026-11-20T10:00:00-05:00",
    "2026-11-20T15:00:00+23:59", "2028-02-29T00:00:00Z", "2000-02-29", "2026-12-31", "0001-01-01T00:00:00Z"];
  const INVALID = ["2026-11-20T15:00:60Z", "2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "1900-02-29", "2026-04-31", "2026-11-20T24:00:00Z",
    "2026-11-20T25:00Z", "2026-11-20T15:60Z", "2026-11-20T15:00+24:00", "2026-11-20T15:00+05:60", "2026-00-10", "2026-13-01", "2026-11-00",
    "2026-11-20T15:00:00", "2026-11-20 15:00Z", "20261120", "+002026-11-20T15:00Z"];
  it("an instant only for a real date and time, equal to Date.parse whenever that is", () => {
    for (const t of VALID) expect(isoMillis(t), t).toBe(Date.parse(t));
    for (const t of INVALID) expect(isoMillis(t), t).toBeNull();
  });
  it("the closed grammar only refuses more: a check time, a value or a time in a fixed sentence on a day that doesn't exist", () => {
    const base = { tool: "sunday.overview", source: "Planning Center Services", check_time: "2026-11-20T15:00:00Z", completeness: "complete", payload: {} };
    expect(envelopeProblems(base)).toEqual([]);
    for (const t of ["2026-11-20T15:00:60Z", "2026-02-30T15:00:00Z"]) expect(envelopeProblems({ ...base, check_time: t })).toContain("check_time");
    expect(isIsoTime("2026-02-30")).toBe(false);
    expect(isIsoTime("2026-02-28")).toBe(true);
    expect(sentenceFits("2026-02-28")).toBe(true);
    expect(sentenceFits("2026-02-30")).toBe(false);
  });
  it("a copy with any such time is refused whole, and a real February 29 is kept", async () => {
    expect((await oddTimes()).map(t => parseSharedCheck(t) !== null)).toEqual([false, false, false, true, false, false, false]);
  });
});

describe("the built script (vite.share.config.ts) needs nothing but JavaScript", () => {
  it("runs in a context with no Node globals at all and answers as the Node server does", async () => {
    const built = await build({ configFile: new URL("../../mcp/vite.share.config.ts", import.meta.url).pathname, logLevel: "silent", build: { write: false, emptyOutDir: false } });
    const output = (Array.isArray(built) ? built[0]! : built as Rollup.RollupOutput).output;
    expect(output.map(o => o.fileName)).toEqual(["ozzie-share.js"]);
    const script = (output[0] as Rollup.OutputChunk).code;
    // A classic script: no import or export, nothing from Node.
    expect(script).not.toMatch(/^\s*(?:import|export)\b|\bimport\(|\brequire\(|\bprocess\.|\bBuffer\b|\bnode:/mu);
    const context = createContext({});
    expect(runInContext("typeof process + typeof Buffer + typeof require + typeof TextEncoder + typeof fetch", context)).toBe("undefined".repeat(5));
    runInContext(script, context, { filename: "ozzie-share.js" });
    const share = runInContext("OzzieShare", context) as { createServer: typeof createServer; MAX_LINE: number };
    expect(share.MAX_LINE).toBe(MAX_LINE);
    const text = await sharedText(FIXTURES[0]![1]());
    for (const shared of [text, ...await oddTimes()]) {
      const inContext = share.createServer(() => shared), node = new McpServer({ read: () => shared, skills });
      for (const line of LINES) expect(inContext(line), line.slice(0, 80)).toBe(node.line(line));
    }
  }, 60_000);
});

describe("background checks", () => {
  const BACKGROUND = /background|check on file|expire|clearance|cleared|screening/iu;
  it.each(FIXTURES.filter(([label]) => label.startsWith("kids teams")))("%s: no wording or fact about one in the copy or anything a tool says", async (_label, make) => {
    const data = make();
    const findings = data.brief!.findings;
    const background = findings.filter(f => f.kind === "background-check");
    const text = await sharedText(data);
    expect(text).not.toMatch(BACKGROUND);
    const embedded = createServer(() => text), node = new McpServer({ read: () => text, skills });
    const out = TOOLS.map((t, i) => {
      const answer = embedded(callTool(i, t.name));
      expect(answer).toBe(node.line(callTool(i, t.name)));
      return (JSON.parse(answer!) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    }).join("\n");
    expect(out).not.toMatch(BACKGROUND);
    // Even the counts leave them out: the overview counts what the Sunday page counts (rooms, follow-ups and group meetings
    // included; live review 2026-11-18) less the background checks, and says some findings are shown only in Ozzie.
    const others = findings.filter(f => f.kind !== "background-check");
    const count = (tone: string, list: typeof findings) => list.filter(f => f.tone === tone).length;
    const shown = sundayShownCount(applyDecisions(data.brief!, data.decisions), data.operations);
    expect(out).toContain(`this check found ${shown.decisions - count("decision", background)} items that need a decision and ${shown.looks - count("look", background)} worth a look`);
    expect(out).toContain("Some findings are shown only in Ozzie on this Mac");
    if (background.length) expect(count("decision", findings) + count("look", findings)).toBeGreaterThan(count("decision", others) + count("look", others));
  });

  it("the fixture really holds background-check findings to leave out", () => {
    const data = FIXTURES.find(([label]) => label === "kids teams and background checks")![1]();
    expect(data.brief!.findings.filter(f => f.kind === "background-check").length).toBeGreaterThan(0);
  });
});
