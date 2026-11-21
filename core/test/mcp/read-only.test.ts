// What another AI app can ask of Ozzie's server (core/mcp), pinned here as a read-only allowlist: the four reads and
// nothing else, each marked read-only, taking no argument, and reaching no module that could change or send anything.
// Also the copy Claude reads for the fictional check, through both the Node server and the entry Ozzie's bundled helper
// runs: no fictional person's name, email address or phone number, even when one is planted in a name.
// Adding a name to READ_ONLY needs a recorded owner decision; a tool that changes anything never belongs in it
// (AGENTS.md rule 5, docs/handoff/NEVER-LIST.md item 6).
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasContactDetailStrict } from "../../src/ask.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { namedIn } from "../../src/harness/names.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../src/harness/tools.js";
import { createServer } from "../../mcp/embedded.js";
import { NOT_SHARED } from "../../mcp/render.js";
import { McpServer, TOOLS, type Response } from "../../mcp/server.js";
import { parseSharedCheck, sharedCheckText, sharedEnvelopes } from "../../mcp/snapshot.js";
import { harnessData } from "../harness/fixtures.js";

/** The only reads another AI app may ask Ozzie for. Read-only, no arguments, Ozzie's last saved check only. */
const READ_ONLY = Object.freeze(["sunday_readiness", "rooms_follow_ups_groups", "church_rules", "what_happened"]);
/** Words a tool that changes or sends something would carry in its name. */
const WRITE_WORDS = /(?:^|_)(?:add|assign|remove|unassign|delete|update|change|edit|set|write|create|send|message|email|text|notify|remind|schedule|confirm|accept|decline|approve|cancel|refresh|post|put|patch)(?:_|$)/u;

const skills = await bundledSkills();
const listed = (server: { handle: McpServer["handle"] }) =>
  ((server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as { result: { tools: Record<string, unknown>[] } }).result.tools);

describe("the read-only allowlist", () => {
  it("lists exactly the allowed reads: a tool added to the server fails here until an owner decision adds it", () => {
    expect(TOOLS.map(t => t.name)).toEqual([...READ_ONLY]);
    expect(listed(new McpServer({ read: () => null, skills })).map(t => t["name"])).toEqual([...READ_ONLY]);
    // The entry Ozzie's bundled helper runs in JavaScriptCore lists the same, and nothing more.
    const embedded = createServer(() => null);
    const tools = (JSON.parse(embedded(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }))!) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map(t => t.name)).toEqual([...READ_ONLY]);
  });

  it("marks every read read-only, not destructive, idempotent and closed-world, with a title, a short name and no argument", () => {
    for (const t of listed(new McpServer({ read: () => null, skills }))) {
      const name = t["name"] as string;
      expect(name.length, name).toBeLessThanOrEqual(64);
      expect(name, name).not.toMatch(WRITE_WORDS);
      expect(t["title"], name).toEqual(expect.any(String));
      expect(t["annotations"], name).toEqual({ title: t["title"], readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t["inputSchema"], name).toEqual({ type: "object", properties: {}, additionalProperties: false });
    }
    // Descriptions promise reading only.
    for (const t of TOOLS) expect(t.description, t.name).not.toMatch(/\b(?:adds?|changes?|updates?|sends?|writes?|deletes?|removes?|schedules?)\b(?! anything)/iu);
  });

  it("refuses any tool that isn't on the list, however it is named", () => {
    const server = new McpServer({ read: () => null, skills });
    for (const name of ["add_to_role", "remove_from_role", "send_message", "change_schedule", "planning_center_refresh", "sunday_readiness_write", "SUNDAY_READINESS", " sunday_readiness"]) {
      expect(server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } }), name).toMatchObject({ error: { code: -32602 } });
    }
    // No other kind of request is served: no resources, prompts, completions or sampling.
    for (const method of ["resources/list", "resources/read", "prompts/list", "prompts/get", "completion/complete", "sampling/createMessage", "logging/setLevel"]) {
      expect(server.handle({ jsonrpc: "2.0", id: 4, method }), method).toMatchObject({ error: { code: -32601 } });
    }
  });

  it("reaches no module that could change Planning Center, send anything, start a program or use the network", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const seen = new Set<string>();
    const outside = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      // Each import or export statement, and each dynamic import, by the module it names.
      // Either quote style: some of core/src uses single quotes.
      for (const m of src.matchAll(/^\s*(?:(?:import|export)\b[^;"']*?\bfrom\s*|import\s*)(["'])([^"'\n]+)\1|\bimport\(\s*(["'])([^"'\n]+)\3\s*\)/gmu)) {
        const spec = (m[2] ?? m[4])!;
        if (!spec.startsWith(".")) { outside.add(spec); continue; }
        const target = resolve(dirname(file), spec.replace(/\?raw$/u, "").replace(/\.js$/u, ".ts"));
        if (target.endsWith(".ts")) visit(target);
        else expect(relative(root, target), `${relative(root, file)} imports ${spec}`).toMatch(/^core\/(?:mcp|src|skills)\//u);
      }
    };
    for (const entry of ["main.ts", "embedded.ts", "server.ts", "file.ts"]) visit(join(root, "core/mcp", entry));
    const files = [...seen].map(f => relative(root, f)).sort();
    expect(files.length).toBeGreaterThan(5);
    // Only Ozzie's open core: never the desktop app (where the one confirmed change lives) or the native crate.
    for (const f of files) expect(f, f).toMatch(/^core\/(?:mcp|src)\//u);
    // Nothing from outside but Node's file and path modules (main.ts and file.ts read the one shared file).
    expect([...outside].sort()).toEqual(["node:fs", "node:os", "node:path"]);
    for (const f of files) {
      const code = readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
      expect(code, f).not.toMatch(/@tauri-apps|\binvoke\s*[(<]|XMLHttpRequest|WebSocket|\bfetch\s*\(|\brequire\s*\(/u);
    }
  });
});

describe("the copy Claude reads for the fictional check", () => {
  const COPY = "B4K7Q2X9M3T8";
  const answers = async (data: HarnessData) => {
    const envelopes = await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => data.capture!.completed_at }));
    const text = sharedCheckText(envelopes, [], "2026-11-20T15:06:00Z", COPY);
    expect(parseSharedCheck(text)).not.toBeNull();
    const node = new McpServer({ read: () => text, skills });
    const helper = createServer(() => text);
    return READ_ONLY.flatMap(name => {
      const line = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: {} } });
      const viaNode = node.handle(JSON.parse(line)) as Response;
      const viaHelper = JSON.parse(helper(line)!) as Response;
      expect(viaHelper, name).toEqual(viaNode);
      return ((viaNode as { result: { content: { text: string }[] } }).result.content).map(c => c.text);
    }).join("\n");
  };
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
  const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/u;

  it("holds no fictional person's name, email address or phone number, and says what it is", async () => {
    const data = harnessData();
    const out = await answers(data);
    expect(out).not.toContain(NOT_SHARED);
    expect(out).toContain("This is fictional example data.");
    expect(namedIn(out, data.capture!.names, "strict")).toBe(false);
    for (const name of Object.values(data.capture!.names)) for (const part of name.split(/\s+/u)) expect(out, part).not.toContain(part);
    expect(out).not.toMatch(EMAIL);
    expect(out).not.toMatch(PHONE);
    expect(hasContactDetailStrict(out)).toBe(false);
  });

  it("keeps an email address and a phone number planted in a fictional person's name out of every answer", async () => {
    const data = harnessData();
    const [first] = Object.keys(data.capture!.names);
    // Its parts are words found nowhere in Ozzie's own sentences (a domain such as example.org would match "This is
    // fictional example data." under the strict rule, which reads every part of a name in any case).
    const planted = "Avery Brightwater (averybw@brightwatermail.net, 555-201-3344)";
    data.capture!.names[first!] = planted;
    const out = await answers(data);
    expect(out).not.toContain(NOT_SHARED);
    expect(out).toMatch(/\[Person \d+\]/u);
    for (const s of ["Avery", "Brightwater", "averybw", "brightwatermail", "555-201-3344", "2013344"]) expect(out, s).not.toContain(s);
    expect(namedIn(out, data.capture!.names, "strict")).toBe(false);
    expect(hasContactDetailStrict(out)).toBe(false);
  });
});
