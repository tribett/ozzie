// Skills (owner decisions: reusable procedures in plain language, shown under "See how this works").
// A skill is core/skills/<id>.md: frontmatter (id, title, purpose, tools, needs, runs), then the
// procedure in plain words for a pastor to read. Loading a skill never grants access: the broker
// still admits only skill.tools ∩ NATIVE_TOOL_ALLOWLIST ∩ the granted scopes.
//
// The checks refuse anything that isn't a reviewed, plain procedure: unknown tools or fields, a
// Calendar/People/Groups tool without that need, words people shouldn't see ("skill", "agent",
// "log", "connector", "harness", "session"), technical tool names, and any sentence that tells
// someone to send, write back, change Planning Center, rank or score people, or write religious
// content (saying what is never done is fine).
//
// `hash` is the sha-256 of the whole file through Web Crypto, which the desktop webview and Node
// both provide, so What happened can name the exact version that ran.
import { NATIVE_TOOL_ALLOWLIST, type Skill, type ToolName } from "./contract.js";
import { OPERATIONS_TOOLS } from "./tools.js";

/** The procedure every Ask question runs. */
export const ASK_SKILL = "answer-from-what-was-read";
export interface SkillFile { path: string; text: string }
export type SkillCheck = { ok: true; skill: Omit<Skill, "hash"> } | { ok: false; problems: string[] };

const FIELDS = ["id", "title", "purpose", "tools", "needs", "runs"] as const;
const LISTS: ReadonlySet<string> = new Set(["tools", "needs", "runs"]);
const NEEDS: ReadonlySet<string> = new Set(["services", "operations"]);
const RUNS: ReadonlySet<string> = new Set(["on-request", "automatic"]);
const TOOLS: ReadonlySet<string> = new Set(NATIVE_TOOL_ALLOWLIST);

/** Frontmatter as `key: value` or `key: a, b` / `key: [a, b]` lines between `---` fences, then the body. */
export function parseSkill(text: string): { meta: Record<string, string | string[]>; body: string; duplicate: string[] } | null {
  const m = /^---\r?\n([^]*?)\r?\n---[ \t]*(?:\r?\n|$)([^]*)$/u.exec(text);
  if (!m) return null;
  const meta: Record<string, string | string[]> = {};
  const duplicate: string[] = [];
  for (const line of m[1]!.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const kv = /^([a-z_]+):[ \t]*(.*)$/u.exec(line);
    if (!kv) { duplicate.push(`unreadable line: ${line.trim().slice(0, 40)}`); continue; }
    const [, key, raw] = kv as unknown as [string, string, string];
    if (Object.hasOwn(meta, key)) duplicate.push(`repeated field: ${key}`);
    const value = raw.trim();
    meta[key] = LISTS.has(key) ? value.replace(/^\[(.*)\]$/u, "$1").split(",").map(s => s.trim()).filter(Boolean) : value;
  }
  return { meta, body: m[2]!.trim(), duplicate };
}

// Words for people (header). Whole words, any case.
const HIDDEN_WORDS = /\b(?:skills?|agents?|agentic|logs?|logging|connectors?|harness(?:es)?|sessions?)\b/iu;
const TOOL_NAME = /\b[a-z_]+\.[a-z_]+\b/u;
/** A sentence that says what is never done. */
const NEGATED = /\b(?:never|not|no|nobody|nothing|none|nor|without|don't|doesn't|isn't|aren't|won't|can't|cannot|didn't)\b/iu;
/** Sentences that tell someone to act outside Ozzie's read-and-draft role, by their first word. */
const ACTION_START = /^(?:send|e-?mail|text|message|call|phone|notify|contact|invite|post|publish|forward|reply|update|change|edit|delete|remove|add|assign|reassign|schedule|reschedule|book|cancel|confirm|decline|approve|mark|rank|score|rate|sort|order|grade|pick|choose|select|pray|bless)\b/iu;
/** Things a procedure never asks for, wherever they appear, unless the sentence says they are never done. */
const NEVER_ASKED = [
  /\bwrite\s+(?:back\s+)?(?:to|into)\b/iu, /\b(?:update|change|edit)\s+planning\s+center\b/iu,
  /\brank\w*\b/iu, /\bscor(?:e|es|ed|ing)\b/iu, /\brating\b/iu, /\bbest\s+(?:person|people|fit|choice|candidate|volunteer|pick)\b/iu,
  /\b(?:most|least)\s+(?:reliable|faithful|committed|dependable|likely)\b/iu, /\bwho\s+to\s+ask\s+first\b/iu, /\bask\s+\w+\s+first\b/iu,
  /\bat[\s-]risk\b/iu, /\bdrift\w*\b/iu, /\bpray\w*\b/iu, /\bsermon\w*\b/iu, /\bscripture\w*\b/iu, /\bdevotion\w*\b/iu, /\bbless\w*\b/iu, /\bverses?\b/iu,
  /\bsend\s+(?:it|this|that|them|the|a|an|out|messages?|notes?|emails?)\b/iu,
];
const LEAD_IN = /^(?:[-*•]\s*|\d+[.)]\s*)?(?:(?:then|and|now|please|also|first|next|finally|so)[,]?\s+)*/iu;
const sentences = (text: string) => text.split(/(?<=[.!?;:])\s+|\r?\n+/u).map(s => s.trim()).filter(Boolean);

function wordingProblems(where: string, text: string): string[] {
  const out: string[] = [];
  if (HIDDEN_WORDS.test(text)) out.push(`${where} uses a word people shouldn't see: ${HIDDEN_WORDS.exec(text)![0]}`);
  if (TOOL_NAME.test(text)) out.push(`${where} names a tool: ${TOOL_NAME.exec(text)![0]}`);
  for (const s of sentences(text)) {
    const lead = s.replace(LEAD_IN, "");
    if (ACTION_START.test(lead)) out.push(`${where} tells someone to act: "${s.slice(0, 60)}"`);
    else if (!NEGATED.test(s) && NEVER_ASKED.some(re => re.test(s))) out.push(`${where} asks for something Ozzie never does: "${s.slice(0, 60)}"`);
  }
  return out;
}

/** Every reason a skill file can't be used; an empty list means it can. */
export function checkSkill(file: SkillFile): SkillCheck {
  const parsed = parseSkill(file.text);
  if (!parsed) return { ok: false, problems: ["missing frontmatter"] };
  const { meta, body } = parsed;
  const problems = [...parsed.duplicate];
  for (const key of Object.keys(meta)) if (!(FIELDS as readonly string[]).includes(key)) problems.push(`unknown field: ${key}`);
  for (const key of FIELDS) {
    const v = meta[key];
    if (v === undefined || (Array.isArray(v) ? v.length === 0 : !v)) problems.push(`missing ${key}`);
  }
  const text = (key: string) => typeof meta[key] === "string" ? meta[key] : "";
  const list = (key: string) => Array.isArray(meta[key]) ? meta[key] : [];
  const id = text("id"), title = text("title"), purpose = text("purpose");
  const tools = list("tools"), needs = list("needs"), runs = list("runs");
  if (id && !/^[a-z][a-z0-9-]{1,40}$/u.test(id)) problems.push("id must be lower-case words joined by hyphens");
  if (id && file.path.replace(/^.*\//u, "") !== `${id}.md`) problems.push("id must match the file name");
  if (title.length > 60) problems.push("title is too long");
  if (purpose && (purpose.length > 200 || !/[.]$/u.test(purpose))) problems.push("purpose must be one sentence ending with a full stop");
  for (const t of tools) if (!TOOLS.has(t)) problems.push(`unknown tool: ${t}`);
  if (new Set(tools).size !== tools.length) problems.push("a tool is listed twice");
  for (const n of needs) if (!NEEDS.has(n)) problems.push(`unknown needs: ${n}`);
  if (needs.length && !needs.includes("services")) problems.push("needs must include services");
  for (const t of tools) if (OPERATIONS_TOOLS.has(t as ToolName) && !needs.includes("operations")) problems.push(`${t} needs operations`);
  for (const r of runs) if (!RUNS.has(r)) problems.push(`unknown runs: ${r}`);
  if (!body) problems.push("empty body");
  if (body.length > 4000) problems.push("body is too long");
  problems.push(...wordingProblems("title", title), ...wordingProblems("purpose", purpose), ...wordingProblems("body", body));
  if (problems.length) return { ok: false, problems };
  return { ok: true, skill: {
    id, title, purpose, tools: tools as ToolName[], needs: needs as Skill["needs"], runs: runs as Skill["runs"], body,
  } };
}

/** Lower-case hex sha-256 of the text's UTF-8 bytes (Web Crypto: the webview and Node alike). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Every file checked and hashed. Throws a plain list of problems if any file can't be used, or an id repeats. */
export async function loadSkills(files: readonly SkillFile[]): Promise<ReadonlyMap<string, Skill>> {
  const out = new Map<string, Skill>();
  const problems: string[] = [];
  for (const file of files) {
    const checked = checkSkill(file);
    if (!checked.ok) { problems.push(...checked.problems.map(p => `${file.path}: ${p}`)); continue; }
    if (out.has(checked.skill.id)) { problems.push(`${file.path}: repeated id ${checked.skill.id}`); continue; }
    out.set(checked.skill.id, Object.freeze({ ...checked.skill, tools: Object.freeze([...checked.skill.tools]) as ToolName[],
      needs: Object.freeze([...checked.skill.needs]) as Skill["needs"], runs: Object.freeze([...checked.skill.runs]) as Skill["runs"],
      hash: await sha256Hex(file.text) }));
  }
  if (problems.length) throw new Error(`Skills couldn't be loaded:\n${problems.join("\n")}`);
  return out;
}
