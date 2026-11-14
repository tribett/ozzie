// A TypeScript mirror of the native agent_step request checks (core/native-auth/src/agent.rs
// `check_step`, harness plan H3), so anything the harness would send that native would refuse fails
// here in CI first. Mirrors: hidden characters, spelled escapes (\u, \x, &#), contact details (7+
// digits or an email), names as whole words with labels and bracketed runs stripped, JSON-in-text
// nesting (4 levels), placeholder label kinds, call ids, task ids, and every size limit.
// One addition is stricter than native: every bracketed token in a decoded string must be a known label.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { containsNameWord, hasContactDetail } from "../../src/ask.js";
import { NATIVE_TOOL_ALLOWLIST, type AgentStepRequest, type ToolSpec } from "../../src/harness/contract.js";
import { envelopeProblems, PROCEDURE_PROMPT, TOOL_SPEC_LIST, VOCABULARY } from "../../src/harness/fixed.js";
import { namedIn } from "../../src/harness/names.js";

export const NATIVE_LIMITS = Object.freeze({
  tools: 13, messages: 32, context: 40_000, system: 16_000, user: 8_000, toolContent: 6_000, reply: 4_000, arguments: 2_000,
  description: 400, propertyDescription: 200, properties: 8, enumValues: 16, enumChars: 64, toolCalls: 10, maxTokens: 700, depth: 4,
});
const KINDS = ["Person", "Role", "Room", "Team", "Group", "Event", "Leader", "Volunteer", "Service", "Location", "Resource", "Position", "Workflow", "Step"];
/** A label native knows: [Kind N] (1–9999, no leading zero) or [Kind A], or a fixed label. */
export const NATIVE_LABEL = new RegExp(`\\[(?:(?:${KINDS.join("|")}) (?:[1-9]\\d{0,3}|[A-Z])|Your name|a team member|Role)\\]`, "gu");
const ALLOWED: ReadonlySet<string> = new Set(NATIVE_TOOL_ALLOWLIST);
type Names = Readonly<Record<string, string>>;

/** Line breaks other than \n, controls other than \t, format, private-use, surrogate and separator characters. */
const hidden = (c: string) => c !== "\n" && c !== "\t" && /[\r\v\f\u0085\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u.test(c);
const spelledEscape = (text: string) => text.includes("&#") || /\\[uUxX]/u.test(text);
/** Native `named`: labels removed outright and as spaces, and every innermost bracketed run removed the same two ways; raw and NFKC. */
function named(text: string, names: Names): boolean {
  const forms = [...new Set([text, text.normalize("NFKC")])];
  return forms.some(form => [
    form.replace(NATIVE_LABEL, ""), form.replace(NATIVE_LABEL, " "), form.replace(/\[[^[\]]*\]/gu, ""), form.replace(/\[[^[\]]*\]/gu, " "),
  ].some(variant => containsNameWord(variant, names)));
}
function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); jsonStrings(v, out); }
  return out;
}

/** Native `text_ok`: every reason a text would be refused, recursing into JSON text up to four levels. */
export function textProblems(text: string, names: Names, depth = 0): string[] {
  const problems: string[] = [];
  if ([...text].some(hidden)) problems.push("hidden character");
  if (spelledEscape(text)) problems.push("spelled escape");
  if (hasContactDetail(text) || hasContactDetail(text.normalize("NFKC"))) problems.push("contact detail (7+ digits or an email)");
  if (named(text, names)) problems.push("a roster name as a word");
  if (problems.length) return problems;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return []; }
  const strings = jsonStrings(value);
  if (!strings.length) return [];
  if (depth >= NATIVE_LIMITS.depth) return ["JSON nested too deeply in text"];
  return [...new Set(strings.flatMap(s => textProblems(s, names, depth + 1)))];
}

/** Stricter than native: bracketed tokens in decoded strings that aren't known labels. */
export function unknownBrackets(value: unknown): string[] {
  const texts = typeof value === "string" ? (() => { try { return jsonStrings(JSON.parse(value)); } catch { return [value]; } })() : jsonStrings(value);
  return texts.flatMap(t => [...t.matchAll(/\[[^[\]\n]*\]/gu)].map(m => m[0]).filter(b => !new RegExp(`^${NATIVE_LABEL.source}$`, "u").test(b)));
}

const chars = (s: string) => [...s].length;
const within = (s: string, min: number, max: number) => chars(s) >= min && chars(s) <= max;

export function specProblems(spec: ToolSpec, names: Names): string[] {
  const p: string[] = [];
  if (!ALLOWED.has(spec.name)) p.push(`tool not allowlisted: ${spec.name}`);
  if (!within(spec.description, 1, NATIVE_LIMITS.description)) p.push(`${spec.name}: description length`);
  p.push(...textProblems(spec.description, names).map(x => `${spec.name} description: ${x}`));
  const params = spec.parameters;
  if (params.type !== "object" || params.additionalProperties !== false) p.push(`${spec.name}: parameters must be a closed object`);
  const props = Object.entries(params.properties);
  if (props.length > NATIVE_LIMITS.properties) p.push(`${spec.name}: too many properties`);
  for (const [name, prop] of props) {
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(name)) p.push(`${spec.name}: property name ${name}`);
    p.push(...textProblems(name, names).map(x => `${spec.name}.${name}: ${x}`));
    if (!["string", "integer", "boolean"].includes(prop.type)) p.push(`${spec.name}.${name}: type`);
    if (!within(prop.description, 1, NATIVE_LIMITS.propertyDescription)) p.push(`${spec.name}.${name}: description length`);
    p.push(...textProblems(prop.description, names).map(x => `${spec.name}.${name} description: ${x}`));
    if (prop.enum) {
      if (prop.type !== "string" || prop.enum.length < 1 || prop.enum.length > NATIVE_LIMITS.enumValues || new Set(prop.enum).size !== prop.enum.length) p.push(`${spec.name}.${name}: enum`);
      for (const v of prop.enum) if (!within(v, 1, NATIVE_LIMITS.enumChars) || textProblems(v, names).length) p.push(`${spec.name}.${name}: enum value`);
    }
  }
  for (const r of params.required) if (!Object.hasOwn(params.properties, r)) p.push(`${spec.name}: required ${r} isn't a property`);
  if (new Set(params.required).size !== params.required.length) p.push(`${spec.name}: required repeated`);
  return p;
}

const callIdOk = (id: string) => /^call_(?:[1-9]\d?)_(?:0|[1-9]\d?)$/u.test(id);
const taskIdOk = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id);

// ---- The pinned check (reviews 2026-11-14 A1/A2): what native check_step becomes in H5b ----------------

const PINS = JSON.parse(readFileSync(new URL("../../src/harness/fixed/pins.json", import.meta.url), "utf8")) as { procedures: Record<string, { system_sha256: string }> };
const SYSTEMS: ReadonlySet<string> = new Set(Object.values(PINS.procedures).map(p => p.system_sha256));
const CANONICAL = new Map(TOOL_SPEC_LIST.map(s => [s.name, JSON.stringify(s)]));
const sha256 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/**
 * The A1/A2 design, mirrored for H5b: the system message is pinned by hash (pins.json), every tool spec must equal
 * its canonical copy (tool-specs.json), every tool message is `{"error":code}` or an envelope in the closed grammar
 * (vocabulary.json), and only what varies, the user's question and the model's own output, is name-checked, under the
 * owner's "capitalized only" rule. Structure, sizes, hidden characters and contact details stay as `requestProblems`.
 */
export function pinnedRequestProblems(request: AgentStepRequest, names: Names): string[] {
  const p = requestProblems(request, {});
  const named = (text: string, where: string) => {
    const forms = [...new Set([text, text.normalize("NFKC")])];
    if (forms.some(f => [f.replace(NATIVE_LABEL, ""), f.replace(NATIVE_LABEL, " ")].some(v => namedIn(v, names)))) p.push(`${where}: a roster name`);
  };
  const [system, user] = request.messages;
  if (system?.role !== "system" || !SYSTEMS.has(sha256(system.content))) p.push("system message isn't a pinned procedure");
  if (user?.role === "user" && user.content !== PROCEDURE_PROMPT) named(user.content, "question");
  for (const spec of request.tools) if (CANONICAL.get(spec.name) !== JSON.stringify(spec)) p.push(`tool spec ${spec.name} isn't the canonical one`);
  request.messages.forEach((m, at) => {
    if (m.role === "assistant") {
      named(m.content, `message ${at} (assistant)`);
      for (const c of m.tool_calls ?? []) named(c.arguments, `message ${at} arguments`);
    } else if (m.role === "tool") {
      let value: unknown;
      try { value = JSON.parse(m.content); } catch { p.push(`message ${at} (tool): not JSON`); return; }
      const error = value && typeof value === "object" && Object.keys(value).length === 1 ? (value as { error?: unknown }).error : undefined;
      if (typeof error === "string") { if (!VOCABULARY.tool_errors.includes(error)) p.push(`message ${at} (tool): error code`); }
      else p.push(...envelopeProblems(value).map(x => `message ${at} (tool): ${x}`));
    }
  });
  return p;
}

/** Native `check_step`: every reason the whole request would be refused. */
export function requestProblems(request: AgentStepRequest, names: Names): string[] {
  const p: string[] = [];
  if (!taskIdOk(request.task_id)) p.push("task id must be a lower-case UUID");
  if (request.max_tokens < 1 || request.max_tokens > NATIVE_LIMITS.maxTokens) p.push("max_tokens");
  if (request.tools.length > NATIVE_LIMITS.tools || new Set(request.tools.map(t => t.name)).size !== request.tools.length) p.push("tools: too many or repeated");
  for (const spec of request.tools) p.push(...specProblems(spec, names));
  const m = request.messages;
  if (chars(JSON.stringify(m)) > NATIVE_LIMITS.context) p.push("context too long");
  if (m.length < 2 || m.length > NATIVE_LIMITS.messages) p.push("message count");
  if (m[0]?.role !== "system") p.push("system must come first");
  const calls = new Map<string, boolean>();
  let total = 0;
  m.forEach((message, at) => {
    const where = `message ${at} (${message.role})`;
    if (message.role === "system") {
      if (at !== 0) p.push(`${where}: only the first message may be system`);
      if (!within(message.content, 1, NATIVE_LIMITS.system)) p.push(`${where}: length`);
    } else if (message.role === "user") {
      if (!within(message.content, 1, NATIVE_LIMITS.user)) p.push(`${where}: length`);
    } else if (message.role === "assistant") {
      const toolCalls = message.tool_calls ?? [];
      total += toolCalls.length;
      if (!message.content && !toolCalls.length) p.push(`${where}: empty`);
      if (total > NATIVE_LIMITS.toolCalls) p.push(`${where}: too many tool calls`);
      if (chars(message.content) > NATIVE_LIMITS.reply) p.push(`${where}: length`);
      for (const c of toolCalls) {
        if (!callIdOk(c.id) || calls.has(c.id)) p.push(`${where}: call id ${c.id}`);
        calls.set(c.id, false);
        if (!ALLOWED.has(c.name)) p.push(`${where}: tool ${c.name}`);
        let args: unknown = null;
        try { args = JSON.parse(c.arguments); } catch { /* refused below */ }
        if (!within(c.arguments, 2, NATIVE_LIMITS.arguments) || typeof args !== "object" || args === null || Array.isArray(args)) p.push(`${where}: arguments`);
        p.push(...textProblems(c.arguments, names).map(x => `${where} arguments: ${x}`));
      }
    } else {
      if (calls.get(message.tool_call_id) !== false) p.push(`${where}: answers no open call`);
      calls.set(message.tool_call_id, true);
      if (!within(message.content, 1, NATIVE_LIMITS.toolContent)) p.push(`${where}: length`);
      p.push(...unknownBrackets(message.content).map(b => `${where}: unknown label ${b}`));
    }
    p.push(...textProblems(message.content, names).map(x => `${where}: ${x}`));
  });
  return p;
}
