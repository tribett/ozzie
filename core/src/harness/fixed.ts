// The fixed texts a model can receive (reviews 2026-11-14 A1, A2, B-S3), read from core/src/harness/fixed/,
// the single source both this webview code and the native agent_step check read (README.md there):
//   policy.txt        Ozzie's policy, the first part of every system message.
//   tool-specs.json   the 13 tool specs, exactly as offered.
//   vocabulary.json   the closed set of keys and fixed words a tool result may hold, the fact and draft ids,
//                     the closed grammar of a final answer, the system message format and the procedure prompt.
//   common-words.txt  ordinary English words, for the "capitalized only" name rule (names.ts).
// `?raw` makes Vite (the desktop build) and vitest import each file's exact text, as for the skill files.
//
// Because these texts are fixed and pinned on both sides, they are never name-scanned: a church member
// named Church, Sunday or Worth can't make Ozzie's own words fail. What varies is checked instead:
// every string in a tool result must be a fixed value, a placeholder label, an ISO time or date, or
// (under a few keys) a sentence of fixed words (envelopeProblems below), so no source text can ride along.
import commonWordsText from "./fixed/common-words.txt?raw";
import policyText from "./fixed/policy.txt?raw";
import specsText from "./fixed/tool-specs.json?raw";
import vocabularyText from "./fixed/vocabulary.json?raw";
import type { ToolSpec } from "./contract.js";

export interface Vocabulary {
  system_message: { format: string };
  procedure_prompt: string;
  tool_error_message: string;
  tools: string[];
  sources: string[];
  completeness: string[];
  tool_errors: string[];
  labels: { families: string[]; your_name: string; your_name_keys: string[] };
  envelope_keys: string[];
  payload_keys: string[];
  values: string[];
  sentence_keys: string[];
  sentence_words: string[];
  /** Keys whose string is an id, and each one's prefix (fact → "f", draft_id → "d"). */
  ids: { keys: Record<string, string> };
  /** The closed grammar of the model's final reply. */
  answer: { kinds: string[]; max_facts: number };
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
};

/** policy.txt without its final line break. */
export const POLICY = policyText.replace(/\r?\n$/u, "");
export const TOOL_SPEC_LIST: readonly ToolSpec[] = deepFreeze(JSON.parse(specsText) as ToolSpec[]);
export const VOCABULARY: Readonly<Vocabulary> = deepFreeze(JSON.parse(vocabularyText) as Vocabulary);
/** The user message of a procedure task. */
export const PROCEDURE_PROMPT = VOCABULARY.procedure_prompt;
/** Lower-case common English words, one per line in common-words.txt. */
export const COMMON_WORDS: ReadonlySet<string> = new Set(commonWordsText.split(/\r?\n/u).map(w => w.trim()).filter(Boolean));

/** The system message for a procedure: vocabulary.json system_message.format. */
export const systemText = (procedure: { title: string; body: string }): string => {
  const parts: Record<string, string> = { policy: POLICY, title: procedure.title, body: procedure.body };
  return VOCABULARY.system_message.format.replace(/\{(policy|title|body)\}/gu, (_m, part: string) => parts[part]!);
};

// ---- The closed grammar of a tool result ---------------------------------------------------------

const set = (list: readonly string[]): ReadonlySet<string> => new Set(list);
const TOOLS = set(VOCABULARY.tools), SOURCES = set(VOCABULARY.sources), COMPLETENESS = set(VOCABULARY.completeness);
const KEYS = set(VOCABULARY.payload_keys), VALUES = set(VOCABULARY.values), SENTENCE_KEYS = set(VOCABULARY.sentence_keys);
const WORDS = set(VOCABULARY.sentence_words), YOUR_NAME_KEYS = set(VOCABULARY.labels.your_name_keys);
const ID_KEYS: Readonly<Record<string, string>> = VOCABULARY.ids.keys;
/** An id for a key of vocabulary.json `ids` (the key's prefix, then 1–9999 with no leading zero), or null for any other key. */
const idFor = (key: string | null): RegExp | null => key !== null && Object.hasOwn(ID_KEYS, key) ? new RegExp(`^${ID_KEYS[key]!}[1-9]\\d{0,3}$`, "u") : null;
const YOUR_NAME = VOCABULARY.labels.your_name;
const FAMILIES = VOCABULARY.labels.families.join("|");
/** A placeholder label of a family a tool may issue, anywhere in a text. */
export const ENVELOPE_LABEL = new RegExp(`\\[(?:${FAMILIES}) [1-9]\\d{0,3}\\]`, "gu");
const WHOLE_LABEL = new RegExp(`^\\[(?:${FAMILIES}) [1-9]\\d{0,3}\\]$`, "u");
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_IN_TEXT = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2}))?/gu;
const SENTENCE_CHARACTERS = /^[A-Za-z0-9 \n.,;:?!'()-]*$/u;
const WORD = /[A-Za-z]+(?:'[A-Za-z]+)*/gu;

/** An ISO 8601 date-time or date that is also a real date. */
export const isIsoTime = (text: string): boolean => (DATETIME.test(text) || DATE.test(text)) && !Number.isNaN(Date.parse(text));

/** A sentence of fixed words: labels and ISO times set aside, only sentence_words and counts remain. */
function sentenceOk(text: string, yourName: boolean, isLabel: (label: string) => boolean): boolean {
  let unknown = false;
  let rest = text.replace(ENVELOPE_LABEL, label => { if (!isLabel(label)) unknown = true; return " "; });
  if (yourName) rest = rest.split(YOUR_NAME).join(" ");
  if (unknown || /[[\]]/u.test(rest)) return false;
  rest = rest.replace(TIME_IN_TEXT, " ");
  if (!SENTENCE_CHARACTERS.test(rest)) return false;
  return (rest.match(WORD) ?? []).every(w => WORDS.has(w.toLowerCase()));
}
/** Whether one of Ozzie's own sentences (such as a "not checked" line) is made only of fixed words, counts and times. */
export const sentenceFits = (text: string): boolean => sentenceOk(text, false, () => false);

function valueProblems(value: unknown, key: string | null, path: string, isLabel: (label: string) => boolean, out: string[]): void {
  const id = idFor(key);
  if (id) {
    // Under an id key, an id and nothing else; never anything else's value.
    if (typeof value !== "string" || !id.test(value)) out.push(`${path}: not an id`);
    return;
  }
  if (typeof value === "string") {
    if (VALUES.has(value) || isIsoTime(value) || (WHOLE_LABEL.test(value) && isLabel(value))) return;
    if (key !== null && SENTENCE_KEYS.has(key) && sentenceOk(value, YOUR_NAME_KEYS.has(key), isLabel)) return;
    out.push(`${path}: not a fixed value, label, time or fixed sentence`);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) out.push(`${path}: not a count`);
  } else if (typeof value === "boolean") {
    return;
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => valueProblems(v, key, `${path}[${i}]`, isLabel, out));
  } else if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) {
      if (!KEYS.has(k)) out.push(`${path}: key outside the vocabulary`);
      valueProblems(v, k, `${path}.${k}`, isLabel, out);
    }
  } else out.push(`${path}: not a string, count, boolean, list or object`);
}

/**
 * Every way a tool envelope leaves the closed grammar (vocabulary.json); empty when it fits. `isLabel`
 * says whether a label may appear (the session that issued it); by default any well-formed label may,
 * which is all the native check can know.
 */
export function envelopeProblems(envelope: unknown, isLabel: (label: string) => boolean = () => true): string[] {
  const out: string[] = [];
  if (envelope === null || typeof envelope !== "object" || Object.getPrototypeOf(envelope) !== Object.prototype) return ["not an object"];
  const e = envelope as Record<string, unknown>;
  const keys = Object.keys(e);
  if (keys.length !== VOCABULARY.envelope_keys.length || !VOCABULARY.envelope_keys.every(k => keys.includes(k))) out.push("envelope keys");
  if (typeof e["tool"] !== "string" || !TOOLS.has(e["tool"])) out.push("tool");
  if (typeof e["source"] !== "string" || !SOURCES.has(e["source"])) out.push("source");
  if (typeof e["completeness"] !== "string" || !COMPLETENESS.has(e["completeness"])) out.push("completeness");
  if (typeof e["check_time"] !== "string" || !DATETIME.test(e["check_time"]) || Number.isNaN(Date.parse(e["check_time"]))) out.push("check_time");
  const payload = e["payload"];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) out.push("payload");
  else valueProblems(payload, null, "payload", isLabel, out);
  return out;
}

// ---- Fact ids and the final answer ---------------------------------------------------------------

/** Every fact and draft id a tool result holds (vocabulary.json `ids`), leaving out what a tool only echoed back (`asked_for`). */
export function idsIn(envelope: { payload: unknown }): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown, key: string | null) => {
    if (key === "asked_for") return;
    if (typeof value === "string" && idFor(key)?.test(value)) out.add(value);
    else if (Array.isArray(value)) for (const v of value) walk(v, key);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(envelope.payload, null);
  return out;
}

export type AnswerKind = "facts" | "not-covered" | "nothing-needs-a-decision" | "draft";
export interface FinalAnswer { answer: AnswerKind; facts: string[]; draft: string | null }
const ANSWER_KINDS = set(VOCABULARY.answer.kinds);
const FACT_ID = /^f[1-9]\d{0,3}$/u, DRAFT_ID = /^d[1-9]\d{0,3}$/u;
const FENCE_OPEN = /^```(?:json)?$/u;
/**
 * The answer object, read by a scanner that accepts only what the grammar allows, so nothing hides in an escape or a
 * repeated key: `{`, then pairs of a key and either a string or a list of strings, then `}`, with JSON whitespace
 * (space, tab, line feed, carriage return) between tokens. Every string is plain: lower-case letters, digits, "-" and
 * "_" between double quotes, no escape. Mirrored natively (fixed.rs `scan_answer`). Null when anything else is there.
 */
function scanAnswer(text: string): Map<string, string | string[]> | null {
  let i = 0;
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const str = (): string | null => {
    const m = /^"([a-z0-9_-]*)"/u.exec(text.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[1]!;
  };
  const out = new Map<string, string | string[]>();
  ws();
  if (text[i++] !== "{") return null;
  ws();
  if (text[i] === "}") i++;
  else for (;;) {
    ws();
    const key = str();
    if (key === null || out.has(key)) return null;
    ws();
    if (text[i++] !== ":") return null;
    ws();
    if (text[i] === "[") {
      i++; ws();
      const list: string[] = [];
      if (text[i] === "]") i++;
      else for (;;) {
        ws();
        const item = str();
        if (item === null) return null;
        list.push(item);
        ws();
        const c = text[i++];
        if (c === "]") break;
        if (c !== ",") return null;
      }
      out.set(key, list);
    } else {
      const value = str();
      if (value === null) return null;
      out.set(key, value);
    }
    ws();
    const c = text[i++];
    if (c === "}") break;
    if (c !== ",") return null;
  }
  ws();
  return i === text.length ? out : null;
}
/**
 * The model's final reply under the closed grammar (vocabulary.json `answer`), or null. Mirrored natively
 * (fixed.rs `final_answer`): whitespace around it and one optional code fence; then exactly a JSON object with
 * "answer" (a kind), "facts" (distinct fact ids, at most max_facts; required and non-empty for "facts") and "draft"
 * (a draft id; required for "draft" and allowed only there). Nothing else: no prose, no other key, no repeated key.
 */
export function parseAnswer(text: string): FinalAnswer | null {
  let body = text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/gu, "");
  if (body.startsWith("```")) {
    const lines = body.split("\n");
    if (lines.length < 3 || !FENCE_OPEN.test(lines[0]!.replace(/[ \t\r]+$/u, "")) || lines.at(-1)!.replace(/^[ \t\r]+|[ \t\r]+$/gu, "") !== "```") return null;
    body = lines.slice(1, -1).join("\n").replace(/^[ \t\n\r]+|[ \t\n\r]+$/gu, "");
  }
  const o = scanAnswer(body);
  if (!o || [...o.keys()].some(k => !["answer", "facts", "draft"].includes(k))) return null;
  const kind = o.get("answer");
  if (typeof kind !== "string" || !ANSWER_KINDS.has(kind)) return null;
  const facts = o.get("facts");
  if (facts !== undefined && (!Array.isArray(facts) || facts.length > VOCABULARY.answer.max_facts || facts.some(f => !FACT_ID.test(f)) ||
    new Set(facts).size !== facts.length)) return null;
  const list = Array.isArray(facts) ? facts : [];
  if (kind === "facts" && !list.length) return null;
  const draft = o.get("draft");
  if ((kind === "draft") !== (draft !== undefined)) return null;
  if (draft !== undefined && (typeof draft !== "string" || !DRAFT_ID.test(draft))) return null;
  return { answer: kind as AnswerKind, facts: list, draft: typeof draft === "string" ? draft : null };
}
/** A final answer written the one way Ozzie keeps it: answer, then facts when there are any, then draft. */
export const answerText = (a: FinalAnswer): string =>
  JSON.stringify({ answer: a.answer, ...(a.facts.length ? { facts: a.facts } : {}), ...(a.draft ? { draft: a.draft } : {}) });
