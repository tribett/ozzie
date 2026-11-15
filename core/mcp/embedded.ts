// Entry for Ozzie's bundled helper (product/desktop/src-tauri/helpers/share.swift): the same server as main.ts, built
// as one classic script for the Mac's own JavaScriptCore, so the release app needs no Node. The helper reads the
// shared file exactly as file.ts does and reads stdin as serveStream does; this file only answers one line at a time
// (server.ts `McpServer.line`, which keeps the batch rule). No file, network or process call: the helper hands in the
// file's text, and JavaScriptCore has no way to reach anything else.
import { SKILL_FILES } from "../src/harness/bundled-skills.js";
import type { Skill } from "../src/harness/contract.js";
import { checkSkill } from "../src/harness/skills.js";
import { McpServer } from "./server.js";

// The limits the helper enforces before a line or the file ever reaches this script, and the names of the copy and of
// native's on-marker beside it, taken from here so they can't drift.
export { MAX_LINE } from "./server.js";
export { MAX_SHARED_BYTES, ON_FILE, SHARED_FILE } from "./snapshot.js";

/**
 * Ozzie's shipped procedures, each checked by checkSkill exactly as loadSkills checks it, and refused whole on any
 * problem or repeated id. The server shows only their titles and purposes; JavaScriptCore has no Web Crypto, so the
 * version hash loadSkills adds (for What happened inside Ozzie) is left empty here.
 */
export function procedures(): ReadonlyMap<string, Skill> {
  const out = new Map<string, Skill>();
  for (const file of SKILL_FILES) {
    const checked = checkSkill(file);
    if (!checked.ok || out.has(checked.skill.id)) throw new Error(`Skills couldn't be loaded: ${file.path}`);
    out.set(checked.skill.id, Object.freeze({ ...checked.skill, hash: "" }));
  }
  return out;
}

/**
 * The server over `read` (the shared file's text, or null: called on every tool call), as one function from a line of
 * input to the line to write back, or null for nothing. Anything `read` gives that isn't a string reads as no file.
 */
export function createServer(read: () => unknown): (line: string) => string | null {
  const server = new McpServer({ read: () => { const text = read(); return typeof text === "string" ? text : null; }, skills: procedures() });
  return line => server.line(String(line));
}
