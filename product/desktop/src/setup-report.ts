// "Copy a report" in Check my setup (onboarding spec §4.3, lane P6): plain text someone can paste to whoever helps them,
// in codes only. App and macOS versions, chip and memory, each row's verdict as a fixed code word, the AI route kind and
// company (an address only for "Another AI company"), whether AI on this Mac was found, the last check's outcome code and
// time, and the Planning Center access label. Never a key, the church's name or number, plan titles, team names or
// people. Every value passes a closed check here or is left out; native's own report (setup_check `report`) is added
// only when every one of its lines is a known `word: code` that passes the same checks. Pure: no I/O, no clock.
import { granted } from "./connection.js";

export type PlanningCenterCode = "connected" | "sign-in-again" | "unreachable" | "not-connected" | "unknown";
export type ServiceCode = "watching" | "passed" | "waiting" | "none" | "unknown";
export type AiCode = "ready" | "none" | "no-key" | "key-refused" | "not-checked" | "not-on-this-mac" | "month-limit" | "paused" | "not-connected" | "reconnect" | "not-answering" | "unknown";
export type NoticesCode = "allowed" | "denied" | "not-asked" | "unknown";
export type StartCode = "on" | "off" | "unknown";
export type PhoneCode = "on" | "off";
export type AiRoute = "managed" | "own" | "local" | "none";
export type AiCompany = "openai" | "anthropic" | "gemini" | "other";

/** Each row's verdict as its fixed code word (check-setup.tsx `setupRows`). */
export interface RowCodes {
  planning_center: PlanningCenterCode; service: ServiceCode; ai: AiCode; notices: NoticesCode; start_with_mac: StartCode;
  /** Only when the phone row is shown. */
  phone?: PhoneCode | null | undefined;
  /** A church on B1 Church or Breeze: which, and whether its key was checked and kept on this Mac. */
  church_system?: { system: "b1" | "breeze" | "genesis"; connection: "connected" | "not-connected" } | null | undefined;
}
export interface ReportInput {
  app?: { version?: string | null | undefined; macos?: string | null | undefined; chip?: string | null | undefined; memory_gb?: number | null | undefined } | null | undefined;
  rows: RowCodes;
  ai_route: AiRoute;
  ai_company?: AiCompany | null | undefined;
  /** "Another AI company" only: the address's host. Left out if it holds anything in `never`. */
  ai_host?: string | null | undefined;
  local_ai?: boolean | null | undefined;
  last_check?: { outcome: string; at_ms: number } | null | undefined;
  checked_at_ms?: number | null | undefined;
  /** Native's `Scopes::label` ("services", "services-and-operations+check-ins", …). */
  scopes?: string | null | undefined;
  /** setup_check's own `report`. */
  native?: string | null | undefined;
  /**
   * Text that must never be in the report: the church's name, plan titles, team names, people's names. The fields are
   * closed codes already; this is checked again on the only two open ones, the host and native's lines.
   */
  never?: readonly (string | null | undefined)[] | undefined;
}

const ROWS = {
  "planning-center": ["connected", "sign-in-again", "unreachable", "not-connected", "unknown"],
  service: ["watching", "passed", "waiting", "none", "unknown"],
  ai: ["ready", "none", "no-key", "key-refused", "not-checked", "not-on-this-mac", "month-limit", "paused", "not-connected", "reconnect", "not-answering", "unknown"],
  notices: ["allowed", "denied", "not-asked", "unknown"],
  "start-with-mac": ["on", "off", "unknown"],
  phone: ["on", "off"],
  "church-system": ["b1", "breeze", "genesis"],
  "church-system-connection": ["connected", "not-connected"],
  "ai-route": ["managed", "own", "local", "none"],
  "ai-company": ["openai", "anthropic", "gemini", "other", "none"],
  "local-ai": ["yes", "no", "unknown"],
} as const satisfies Record<string, readonly string[]>;
const closed = (all: readonly string[]) => (v: string) => all.includes(v) ? v : null;
const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16) + "Z";
const instantOk = (v: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/u.test(v) && Number.isFinite(Date.parse(v)) ? `${v.slice(0, 16)}Z` : null;
/**
 * A host as typed for "Another AI company": letters, digits, dots and hyphens, with a dot; never Planning Center. Short
 * labels only (30 at most, none starting "sk-"), so a key pasted into the address can't ride out in it.
 */
const hostOk = (v: string) => {
  const h = v.toLowerCase();
  return h.length <= 120 && /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)+$/u.test(h)
    && !h.split(".").some(label => label.startsWith("sk-")) && !/(?:^|\.)planningcenteronline\.com$/u.test(h) ? h : null;
};
/** Each field the report may hold, and the check its value must pass (null: left out). Native's lines use the same. */
const FIELDS: Record<string, (v: string) => string | null> = {
  app: v => /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9a-z]{1,12}(?:\.[0-9a-z]{1,12}){0,2})?$/u.test(v) ? v : null,
  macos: v => /^\d{1,2}(?:\.\d{1,2}){0,2}$/u.test(v) ? v : null,
  chip: v => {
    const c = v.trim().toLowerCase().replace(/\s+/gu, "-");
    return /^(?:apple-m\d{1,2}(?:-(?:pro|max|ultra))?|intel)$/u.test(c) ? c : null;
  },
  "memory-gb": v => /^[1-9]\d{0,3}$/u.test(v) ? v : null,
  ...Object.fromEntries(Object.entries(ROWS).map(([k, all]) => [k, closed(all)])),
  "ai-host": hostOk,
  "last-check": v => /^[a-z][a-z0-9-]{0,39}$/u.test(v) ? v : null,
  "last-check-at": instantOk,
  "checked-at": instantOk,
  // Native writes "none" when Planning Center isn't connected (ai_setup.rs `report`).
  scopes: v => v === "none" || granted({ scopes: v as never }) ? v : null,
};
/** The keys native may write, in its own spelling too (`start_with_mac`), mapped to the report's. */
const keyOf = (k: string) => k.replace(/_/gu, "-").replace(/^ai-provider$/u, "ai-company").replace(/^planning-centre$/u, "planning-center");

/** Words of the `never` list worth looking for: whole entries, and each word of four letters or more. */
function neverWords(never: ReportInput["never"]): string[] {
  const out = new Set<string>();
  for (const n of never ?? []) {
    if (typeof n !== "string") continue;
    const t = n.normalize("NFKC").toLowerCase().trim();
    if (t.length >= 3) out.add(t);
    for (const w of t.split(/[^\p{L}\p{N}]+/u)) if (w.length >= 4) out.add(w);
  }
  return [...out];
}
const holds = (text: string, words: readonly string[]) => { const t = text.toLowerCase(); return words.some(w => t.includes(w)); };

/**
 * Native's report lines, each checked: a known key, then a value that passes that key's check. If any line fails, or
 * any holds a `never` word, none are used (null): a line that isn't a code may be anything.
 */
export function nativeReportLines(text: string | null | undefined, never: ReportInput["never"] = []): string[] | null {
  if (typeof text !== "string" || !text.trim()) return [];
  const words = neverWords(never);
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([a-z][a-z0-9_-]{0,39}): (\S{1,64})$/u.exec(line);
    if (!m) return null;
    const key = keyOf(m[1]!);
    const check = Object.hasOwn(FIELDS, key) ? FIELDS[key] : undefined;
    const value = check ? check(m[2]!) : null;
    if (value === null || holds(line, words)) return null;
    lines.push(`${key}: ${value}`);
    if (lines.length > 40) return null;
  }
  return lines;
}

/** The report, as plain text. */
export function buildReport(input: ReportInput): string {
  const lines: string[] = ["ozzie-setup-report: 1"];
  const add = (key: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined) return;
    const v = FIELDS[key]!(String(value));
    if (v !== null) lines.push(`${key}: ${v}`);
  };
  const app = input.app ?? {};
  add("app", app.version); add("macos", app.macos); add("chip", app.chip);
  add("memory-gb", typeof app.memory_gb === "number" && Number.isSafeInteger(app.memory_gb) ? app.memory_gb : null);
  const r = input.rows;
  add("planning-center", r.planning_center); add("service", r.service); add("ai", r.ai); add("notices", r.notices); add("start-with-mac", r.start_with_mac);
  if (r.phone) add("phone", r.phone);
  if (r.church_system) { add("church-system", r.church_system.system); add("church-system-connection", r.church_system.connection); }
  add("ai-route", input.ai_route);
  add("ai-company", input.ai_route === "none" || input.ai_route === "local" ? null : input.ai_company ?? null);
  // The address only for "Another AI company", and never one that names the church or anyone in it.
  if (input.ai_route === "own" && input.ai_company === "other" && typeof input.ai_host === "string" && !holds(input.ai_host, neverWords(input.never))) add("ai-host", input.ai_host);
  add("local-ai", input.local_ai === true ? "yes" : input.local_ai === false ? "no" : "unknown");
  if (input.last_check && Number.isFinite(input.last_check.at_ms)) {
    add("last-check", input.last_check.outcome);
    if (lines.at(-1)?.startsWith("last-check:")) add("last-check-at", minute(input.last_check.at_ms));
  }
  if (typeof input.checked_at_ms === "number" && Number.isFinite(input.checked_at_ms)) add("checked-at", minute(input.checked_at_ms));
  add("scopes", input.scopes ?? null);
  const native = nativeReportLines(input.native, input.never);
  if (native && native.length) lines.push("from-native: yes", ...native);
  else if (native === null) lines.push("from-native: left-out");
  return `${lines.join("\n")}\n`;
}
