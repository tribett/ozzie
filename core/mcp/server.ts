// Ozzie's read-only server for other AI apps (harness plan H5): the Model Context Protocol over stdio, newline-
// delimited JSON-RPC 2.0, written out here so it needs no package. Four tools, each a fixed read of the shared
// check file (snapshot.ts), re-read and re-checked on every call:
//   sunday_readiness          where this Sunday stands: overview, open roles, pending requests, check-ins, gaps
//   rooms_follow_ups_groups   room bookings, follow-ups without an owner, group meetings at serving times
//   church_rules              the Church rules in words, and the procedures Ozzie follows
//   what_happened             what Ozzie did recently (task kinds and outcomes only)
// No tool takes an argument. There is no tool that writes, sends, reads Planning Center or reaches a network, and no
// resource or prompt; this file holds no file, network or process call at all (main.ts reads the one file).
import type { Skill } from "../src/harness/contract.js";
import { checkText, happenedText, rulesText } from "./render.js";
import { parseSharedCheck, type SharedCheck, type SharedTool } from "./snapshot.js";

export const SERVER_NAME = "ozzie-last-check";
export const SERVER_VERSION = "0.1.0";
/** Protocol versions this server speaks, newest first. A client asking for another gets the newest. */
export const PROTOCOL_VERSIONS = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

export const INSTRUCTIONS = "Read-only access to Ozzie's last saved Sunday readiness check for a church, from the leader's Mac. "
  + "Every result is facts with where they came from and when they were checked. People, roles and rooms appear only as labels such as [Person 1]; "
  + "their names stay in Ozzie and are never available here, so don't guess them. "
  + "Labels such as [Person 1] are only meaningful within one copy of the check: each result names its copy, and the same label in another copy may refer to someone else, so don't match labels across copies. "
  + "Nothing here can check Planning Center again, send anything or change anything; "
  + "a person decides what to do. Don't rank or score people, and don't describe anyone as unreliable or at risk.";

interface ToolDef { name: string; title: string; description: string; run: (read: Reading) => string }
interface Reading { check: SharedCheck | null; skills: ReadonlyMap<string, Skill> }
const SUNDAY: readonly SharedTool[] = ["sunday.overview", "sunday.open_needs", "sunday.pending_requests", "sunday.rule_checkins", "sunday.not_checked"];
const OPERATIONS: readonly SharedTool[] = ["rooms.conflicts", "followups.unowned", "groups.clashes"];

export const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: "sunday_readiness", title: "Sunday readiness",
    description: "Where the church's coming Sunday stands in Ozzie's last saved check: roles that still need people, requests without an answer, suggested check-ins and what the check couldn't cover, each with its source and check time. People appear as labels, never names.",
    run: r => checkText(r.check, SUNDAY),
  },
  {
    name: "rooms_follow_ups_groups", title: "Rooms, follow-ups and group meetings",
    description: "From Ozzie's last saved check: room bookings that overlap, overdue follow-ups without an owner, and group meetings at the same time as someone's serving, when the church's connection includes them. Labels, never names.",
    run: r => checkText(r.check, OPERATIONS),
  },
  {
    name: "church_rules", title: "Church rules",
    description: "The church's rules Ozzie checks against (check-ins, scheduled leads, rooms that aren't shared), in words, and the written procedures Ozzie follows.",
    run: r => rulesText(r.check, r.skills),
  },
  {
    name: "what_happened", title: "What happened",
    description: "What Ozzie did recently on the leader's Mac: checks, questions and procedures, when they ran and how they ended. Never what was asked or answered.",
    run: r => happenedText(r.check, r.skills),
  },
]);

/** The one JSON Schema every tool takes: no arguments. */
const NO_ARGUMENTS = Object.freeze({ type: "object", properties: {}, additionalProperties: false });
const ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

export interface ServerDeps {
  /** The shared check file's text, or null when there is none. Called on every tool call. */
  read(): string | null;
  /** Ozzie's shipped procedures (core/skills), for their titles. */
  skills: ReadonlyMap<string, Skill>;
}

type Id = string | number;
interface Request { jsonrpc: "2.0"; id?: Id; method: string; params?: unknown }
export type Response = { jsonrpc: "2.0"; id: Id | null; result: unknown } | { jsonrpc: "2.0"; id: Id | null; error: { code: number; message: string } };

const error = (id: Id | null, code: number, message: string): Response => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Largest line accepted from the client; anything longer is answered as invalid once and dropped through its newline, unread. */
export const MAX_LINE = 1 << 20;
/** Most requests answered in one JSON-RPC batch; a larger batch is refused whole. */
export const MAX_BATCH = 32;
/** The answer to a line that is too long or a batch that is empty or too large. */
const REFUSED = JSON.stringify(error(null, -32600, "Invalid request"));
const isId = (v: unknown): v is Id => typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v));

export class McpServer {
  readonly #deps: ServerDeps;
  constructor(deps: ServerDeps) { this.#deps = deps; }

  /** One parsed message in, its response out, or null for a notification (which never gets one). */
  handle(message: unknown): Response | null {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return error(null, -32600, "Invalid request");
    const m = message as Partial<Request>;
    const hasId = Object.hasOwn(m, "id");
    // No method: a response to a request this server never sends, or noise. Nothing to answer.
    if (typeof m.method !== "string") return null;
    if (m.jsonrpc !== "2.0" || (hasId && !isId(m.id))) return error(isId(m.id) ? m.id : null, -32600, "Invalid request");
    // A notification (initialized, cancelled …): never answered.
    if (!hasId) return null;
    const id = m.id!;
    switch (m.method) {
      case "initialize": {
        const asked = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return { jsonrpc: "2.0", id, result: {
          protocolVersion, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: "Ozzie's last check", version: SERVER_VERSION }, instructions: INSTRUCTIONS,
        } };
      }
      case "ping": return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: NO_ARGUMENTS, annotations: { title: t.title, ...ANNOTATIONS } })) } };
      case "tools/call": return this.#call(id, m.params);
      default: return error(id, -32601, "Method not found");
    }
  }

  #call(id: Id, params: unknown): Response {
    const p = (typeof params === "object" && params !== null ? params : {}) as { name?: unknown; arguments?: unknown };
    const tool = TOOLS.find(t => t.name === p.name);
    if (!tool) return error(id, -32602, "Unknown tool");
    const args = p.arguments;
    if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args) || Object.keys(args).length)) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "This tool takes no arguments." }], isError: true } };
    }
    let text: string | null = null;
    try { text = this.#deps.read(); } catch { text = null; }
    // A file outside the format reads exactly as no file (render.ts NOT_SHARED).
    const reading: Reading = { check: text === null ? null : parseSharedCheck(text), skills: this.#deps.skills };
    let out: string;
    try { out = tool.run(reading); } catch { return error(id, -32603, "Internal error"); }
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out }], isError: false } };
  }

  /** A line of input to the line(s) to write back: parse errors answered, notifications silent. Too long: refused unread. */
  line(text: string): string | null {
    if (text.length > MAX_LINE) return REFUSED;
    if (!text.trim()) return null;
    let message: unknown;
    try { message = JSON.parse(text); } catch { return JSON.stringify(error(null, -32700, "Parse error")); }
    try {
      if (Array.isArray(message)) {
        // JSON-RPC batches (older protocol versions): each answered; an all-notification batch gets nothing. Empty or
        // larger than MAX_BATCH: refused whole.
        if (!message.length || message.length > MAX_BATCH) return REFUSED;
        const out = message.map(x => this.handle(x)).filter((r): r is Response => r !== null);
        return out.length ? JSON.stringify(out) : null;
      }
      const response = this.handle(message);
      return response ? JSON.stringify(response) : null;
    } catch { return JSON.stringify(error(null, -32603, "Internal error")); }
  }
}

/**
 * Serves one client over a pair of streams until the input ends. Only protocol messages are ever written to `output`.
 * A line longer than MAX_LINE is answered once as invalid and skipped through its newline without being read. While
 * the client isn't taking what was written, reading pauses until it does.
 */
export function serveStream(server: McpServer, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  return new Promise(resolve => {
    let buffer = "";
    let skipping = false;
    let waiting = false;
    const write = (reply: string | null) => {
      if (reply === null || output.write(`${reply}\n`) || waiting) return;
      waiting = true;
      input.pause();
      output.once("drain", () => { waiting = false; input.resume(); });
    };
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/u, "");
        buffer = buffer.slice(at + 1);
        if (skipping) { skipping = false; continue; }
        write(server.line(line));
      }
      if (buffer.length > MAX_LINE) {
        buffer = "";
        if (!skipping) { skipping = true; write(REFUSED); }
      }
    });
    input.on("end", () => { if (!skipping) write(server.line(buffer)); resolve(); });
    input.on("close", () => resolve());
  });
}
