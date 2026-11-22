// "Check my setup" (onboarding spec §4.3, lane P6): from Settings, and from every AI error and failed check. One row for
// each thing Ozzie needs, each a plain verdict and at most one button that fixes it; "Check again" reads everything
// again, and "Copy a report" copies codes only (setup-report.ts) for whoever helps. The facts come from native's
// `setup_check` (contract "Check my setup") through the onboarding bridge. Until native has that command, or where it
// can't say, the rows come from what the page already knows (the connection status, the watched service, the AI
// status, the Mac's login item, notification permission), and "Couldn't check just now" is said only where nothing
// does know. Nothing here changes anything: each button hands the person to the place that does.
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons.js";
import { useDay } from "./day-words.js";
import { churchName, needsSignIn, type ConnectionStatus } from "./connection.js";
import { onboarding, type NoticePermission, type OnboardingBridge, type SetupCheck } from "./onboarding-bridge.js";
import { autostart as macAutostart, type Autostart } from "./background.js";
import type { ModelStatus } from "./model.js";
import {
  buildReport, type AiCode, type AiCompany, type AiRoute, type NoticesCode, type PlanningCenterCode, type ReportInput, type RowCodes, type ServiceCode, type StartCode,
} from "./setup-report.js";
import "./check-setup.css";

export const CHECK_TITLE = "Check my setup";

/** What the page already knows, for the rows native's check can't fill and for the report. */
export interface SetupKnown {
  connection: ConnectionStatus | null;
  /** The watched service: its Planning Center name and whether Ozzie moves on by itself; null when none is chosen. */
  watched: { service: string | null; follows: boolean; date?: string | null | undefined } | null;
  /** The watched service has no upcoming plan (S5d). */
  waiting?: boolean | undefined;
  /** The watched plan's day has passed and the next hasn't been taken yet. */
  passed?: boolean | undefined;
  ai: ModelStatus | null;
  /** The own route's company ("other" for Another AI company) and, for that one only, the address's host. */
  aiCompany?: AiCompany | null | undefined;
  aiHost?: string | null | undefined;
  /** When the AI last answered (ms), for "answered at 9:14 AM". */
  aiAnsweredAtMs?: number | null | undefined;
  /** "December 17", when the AI is paused until a day. */
  aiPausedUntil?: string | null | undefined;
  /** The last key check said the company refused the key. */
  aiKeyRefused?: boolean | undefined;
  /** AI on this Mac didn't answer the last time it was asked. */
  aiNotAnswering?: boolean | undefined;
  /** Phone notices: null leaves the row out (it shows only when they were turned on). */
  phone?: { on: boolean; lastTestMs: number | null } | null | undefined;
  /** For the report only. */
  app?: ReportInput["app"];
  localAiFound?: boolean | null | undefined;
  lastCheck?: { outcome: string; at_ms: number } | null | undefined;
  /** More text the report must never hold (people's names, team names, plan titles). The church and service are added here. */
  never?: readonly string[] | undefined;
  /**
   * A church on B1 Church or Breeze: its own connection, in place of Planning Center's row (native's setup check reads
   * Planning Center only). `connected`: a key was checked and kept on this Mac.
   */
  system?: { name: string; church: string | null; connected: boolean; id?: "b1" | "breeze" | "genesis" } | null | undefined;
}
/** What one round of checking found. `check` is null when native's setup_check isn't built or didn't answer. */
export interface CheckFacts { check: SetupCheck | null; notices: NoticePermission; startOn: boolean | null }

export type RowId = "planning-center" | "service" | "ai" | "notices" | "start" | "phone";
export type FixId = "connect" | "connect-again" | "retry" | "choose-service" | "choose-other" | "change-ai" | "check-key" | "open-local" | "see-plan"
  | "open-notices" | "turn-on-start" | "phone";
export interface SetupRow { id: RowId; label: string; code: string; verdict: string; fix: FixId | null; ok: boolean }
export const FIX_LABEL: Record<FixId, string> = {
  connect: "Connect Planning Center", "connect-again": "Connect again", retry: "Try again", "choose-service": "Choose a service",
  "choose-other": "Choose a different one", "change-ai": "Change", "check-key": "Check the key", "open-local": "Open Ollama", "see-plan": "See my plan",
  "open-notices": "Open Notifications settings", "turn-on-start": "Turn it on", phone: "Open phone settings",
};
export const UNKNOWN = "Couldn't check just now";

const time = (ms: number, zone?: string) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) });
const day = (ms: number, zone?: string) => new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", ...(zone ? { timeZone: zone } : {}) });
const known = <T extends string>(v: T | "unknown" | null | undefined): v is T => typeof v === "string" && v !== "unknown";

/** Planning Center's row from the connection status the page has, when native's check can't say. */
export function planningCenterFrom(s: ConnectionStatus | null): PlanningCenterCode {
  if (!s) return "unknown";
  if (s.state === "connected") return "connected";
  if (needsSignIn(s)) return "sign-in-again";
  if (s.state === "failed") return ["provider-failure", "transport-failure", "rate-limited", "unreachable"].includes(String(s.problem)) ? "unreachable" : "unknown";
  if (s.state === "disconnected" || s.state === "cancelled" || s.state === "expired") return "not-connected";
  return "unknown";
}
/** The AI row from the AI status the page has, when native's check can't say. */
export function aiFrom(m: ModelStatus | null): AiCode {
  if (!m) return "unknown";
  const setup = String(m.setup ?? "");
  if (m.route === "none" || setup === "no-route") return "none";
  if (setup === "no-key" || setup === "own-key-not-bound") return "no-key";
  if (setup === "not-checked") return "not-checked";
  if (setup === "not-on-this-mac") return "not-on-this-mac";
  if (setup === "month-limit") return "month-limit";
  if (setup === "not-connected") return "not-connected";
  if (setup === "reconnect") return "reconnect";
  if (m.route === "managed" && m.account?.warning === "paused") return "paused";
  return m.configured && (setup === "ready" || setup === "") ? "ready" : "unknown";
}
const routeOf = (facts: CheckFacts, k: SetupKnown): AiRoute => facts.check?.ai_route ?? k.ai?.route ?? "none";
const companyOf = (facts: CheckFacts, k: SetupKnown): AiCompany | null => facts.check?.ai_provider ?? k.aiCompany ?? null;
const AI_NAME: Record<AiCompany, string> = { openai: "ChatGPT", anthropic: "Claude", gemini: "Gemini", other: "Another AI company" };
const COMPANY: Record<AiCompany, string> = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Google", other: "The AI company" };
function aiName(route: AiRoute, company: AiCompany | null): string {
  switch (route) {
    case "managed": return "Ozzie's AI";
    case "local": return "AI on this Mac";
    case "own": return company ? `${AI_NAME[company]}, with your key` : "Your own AI key";
    default: return "No AI";
  }
}

/** The rows, in the spec's order, each with its verdict, its fixed code word (for the report) and its one fix. */
export function setupRows(facts: CheckFacts, k: SetupKnown, opts: { date?: string | null | undefined; zone?: string | undefined } = {}): SetupRow[] {
  const c = facts.check;
  const rows: SetupRow[] = [];
  // A church on another system: its row says where Ozzie reads, and what native's check of Planning Center found doesn't apply.
  if (k.system) rows.push({
    id: "planning-center", label: k.system.name, code: k.system.connected ? "connected" : "not-connected", ok: k.system.connected,
    verdict: k.system.connected ? `Connected${k.system.church ? ` to ${k.system.church}` : ""}` : "Not connected yet", fix: k.system.connected ? null : "connect",
  });
  // Planning Center
  const pc: PlanningCenterCode = known(c?.planning_center) ? c.planning_center : planningCenterFrom(k.connection);
  const church = c?.church ?? churchName(k.connection?.organization_name) ?? null;
  const checkedMs = c?.checked_at_ms ?? k.connection?.checked_at_ms ?? null;
  if (!k.system) rows.push({
    id: "planning-center", label: "Planning Center", code: pc, ok: pc === "connected",
    verdict: pc === "connected" ? `${church ? `Connected to ${church}` : "Connected"}${checkedMs ? ` · checked ${time(checkedMs, opts.zone)}` : ""}`
      : pc === "sign-in-again" ? "Needs you to connect again" : pc === "unreachable" ? "Can't reach Planning Center right now"
      : pc === "not-connected" ? "Not connected yet" : UNKNOWN,
    fix: pc === "sign-in-again" ? "connect-again" : pc === "unreachable" ? "retry" : pc === "not-connected" ? "connect" : null,
  });
  // The service Ozzie watches
  const fallbackService: ServiceCode = !k.watched ? "none" : k.passed ? "passed" : k.waiting ? "waiting" : "watching";
  const service: ServiceCode = !k.system && c && known(c.service) && !(c.service === "none" && k.watched) ? c.service : fallbackService;
  const date = opts.date ?? k.watched?.date ?? null;
  const name = k.watched?.service ?? null;
  // Genesis shares no volunteer schedules: there is no service to watch, and nothing to fix (review of e9cbd97d, M5).
  if (k.system?.id === "genesis") rows.push({
    id: "service", label: "The service Ozzie watches", code: "none", ok: true, fix: null,
    verdict: "None: Genesis doesn't share volunteer schedules, so there's no service to watch",
  });
  else rows.push({
    id: "service", label: "The service Ozzie watches", code: service, ok: service === "watching",
    verdict: service === "watching" ? [date, name, k.watched?.follows ? "moves on by itself" : null].filter(Boolean).join(" · ") || "Watching a service"
      : service === "passed" ? `${date ? `${date} has passed` : "That service has passed"}${k.watched?.follows ? " · Ozzie moves on to the next one by itself" : ""}`
      : service === "waiting" ? `Waiting for the next ${name ? `${name} ` : ""}${k.system?.id === "breeze" ? "event" : "plan"}`
      : service === "none" ? "No service chosen" : UNKNOWN,
    // The page always knows whether a service is chosen, so this row is never "Couldn't check just now".
    fix: service === "none" ? "choose-service" : "choose-other",
  });
  // AI
  const route = routeOf(facts, k), company = companyOf(facts, k);
  let ai: AiCode = c && known(c.ai) ? c.ai : aiFrom(k.ai);
  if (route === "own" && k.aiKeyRefused && (ai === "ready" || ai === "unknown")) ai = "key-refused";
  if (route === "local" && k.aiNotAnswering && (ai === "ready" || ai === "unknown" || ai === "not-checked")) ai = "not-answering";
  const label = aiName(route, company);
  const until = k.aiPausedUntil ?? null;
  const firm = company ? COMPANY[company] : "The AI company";
  rows.push({
    id: "ai", label: "AI", code: ai, ok: ai === "ready" || ai === "none",
    verdict: ai === "ready" ? `${label}${k.aiAnsweredAtMs ? ` · answered at ${time(k.aiAnsweredAtMs, opts.zone)}` : " · set up"}`
      : ai === "none" ? "No AI (everything else works)"
      : ai === "no-key" ? `${firm} has no key saved on this Mac`
      : ai === "key-refused" ? `${firm} didn't accept the key`
      : ai === "not-checked" ? "AI on this Mac hasn't been checked yet"
      : ai === "not-on-this-mac" ? "AI on this Mac: the model chosen doesn't run on this Mac, so Ozzie doesn't use it"
      : ai === "month-limit" ? `${label}: ${until ? `paused until ${until}` : "this month's limit is reached"}`
      : ai === "paused" ? `${label}: ${until ? `paused until ${until}` : "paused for now"}`
      : ai === "not-connected" ? "Ozzie's AI isn't connected on this Mac"
      : ai === "reconnect" ? "Ozzie's AI needs you to connect again"
      : ai === "not-answering" ? "AI on this Mac isn't answering" : UNKNOWN,
    fix: ai === "no-key" || ai === "key-refused" ? "check-key" : ai === "not-answering" ? "open-local" : ai === "paused" ? "see-plan" : ai === "unknown" ? null : "change-ai",
  });
  // Notices
  const notices: NoticesCode = c && known(c.notices) ? c.notices : facts.notices;
  rows.push({
    id: "notices", label: "Notices", code: notices, ok: notices === "allowed",
    // This build can't read the setting (contract N8: always "unknown"), so the row says so and opens the pane to look.
    verdict: notices === "allowed" ? "Allowed" : notices === "denied" ? "Turned off for Ozzie in System Settings" : notices === "not-asked" ? "Not asked yet"
      : "Ozzie can't see this setting. Check in System Settings that Ozzie may send notices.",
    fix: notices === "allowed" ? null : "open-notices",
  });
  // Starting with this Mac
  const start: StartCode = c && known(c.start_with_mac) ? c.start_with_mac : facts.startOn === null ? "unknown" : facts.startOn ? "on" : "off";
  rows.push({
    id: "start", label: "Starting with this Mac", code: start, ok: start === "on",
    verdict: start === "on" ? "On" : start === "off" ? "Off: Ozzie checks only while you have it open" : UNKNOWN,
    fix: start === "off" ? "turn-on-start" : null,
  });
  // Phone notices, only when they were turned on
  if (k.phone) rows.push({
    id: "phone", label: "Phone notices", code: k.phone.on ? "on" : "off", ok: true,
    verdict: k.phone.on ? `On${k.phone.lastTestMs ? ` · last test ${day(k.phone.lastTestMs, opts.zone)}` : ""}` : "Off",
    fix: "phone",
  });
  return rows;
}

/** The report for these rows (setup-report.ts): codes only, with the church and the service added to what it must never hold. */
export function reportFor(facts: CheckFacts, k: SetupKnown, rows: readonly SetupRow[], checkedAtMs: number | null): string {
  const code = (id: RowId) => rows.find(r => r.id === id)?.code;
  // A church on another system: its own row is reported as that system's connection, and Planning Center as what is known
  // of Planning Center itself (native's check, else the connection), never the system's connection under Planning Center's name.
  const pc: PlanningCenterCode = known(facts.check?.planning_center) ? facts.check!.planning_center : planningCenterFrom(k.connection);
  const codes: RowCodes = {
    planning_center: k.system ? pc : code("planning-center") as PlanningCenterCode, service: code("service") as ServiceCode, ai: code("ai") as AiCode,
    notices: code("notices") as NoticesCode, start_with_mac: code("start") as StartCode, phone: (code("phone") ?? null) as RowCodes["phone"],
    church_system: k.system?.id ? { system: k.system.id, connection: k.system.connected ? "connected" : "not-connected" } : null,
  };
  const route = routeOf(facts, k);
  return buildReport({
    app: k.app, rows: codes, ai_route: route, ai_company: companyOf(facts, k), ai_host: k.aiHost, local_ai: k.localAiFound, last_check: k.lastCheck,
    checked_at_ms: facts.check?.checked_at_ms ?? checkedAtMs, scopes: k.connection?.scopes ?? null, native: facts.check?.report ?? null,
    never: [facts.check?.church, churchName(k.connection?.organization_name), k.connection?.organization, k.watched?.service, ...(k.never ?? [])],
  });
}

export interface CheckMySetupProps {
  known: SetupKnown;
  /** The watched service's Planning Center ids, for native's check of it. */
  serviceTypeId?: string | undefined; planId?: string | undefined;
  /** The watched plan's local date (YYYY-MM-DD), for native's "passed" (contract L7). */
  planDate?: string | null | undefined;
  onConnect: () => void; onChooseService: () => void; onChangeAi: () => void; onOpenNotices: () => void; onTurnOnStart: () => void; onPhone: () => void;
  /** S8's key sheet; Change (S6) when not given. */
  onCheckKey?: (() => void) | undefined;
  /** Opens Ollama; Change (S9) when not given. */
  onOpenLocal?: (() => void) | undefined;
  /** Ozzie's AI plan page; Change when not given. */
  onSeePlan?: (() => void) | undefined;
  /** "Check again" also asks the page to read its own statuses again (connection, AI). */
  onCheckAgain?: (() => void) | undefined;
  /** The native side (tests pass a fake: test/onboarding-fakes.ts). */
  bridge?: Pick<OnboardingBridge, "setupCheck" | "noticePermission"> | undefined;
  autostart?: Pick<Autostart, "get"> | undefined;
  /** Puts the report on the clipboard (default: the page's clipboard). */
  copy?: ((text: string) => Promise<void>) | undefined;
  /**
   * This Mac's zone (tests pin one): every time on this screen is something that happened on this Mac (when Planning
   * Center was checked, when the AI answered, the last phone test, when this screen checked), so it is on this Mac's
   * clock, never the church's (rule since 0.5.5; polish 4).
   */
  zone?: string | undefined; clock?: (() => number) | undefined;
}

export const COPIED = "Copied. The report has codes only: no names, keys or church details.";
export const COPY_FAILED = "Ozzie couldn't copy the report just now. Try again.";

export function CheckMySetup({ known: k, serviceTypeId, planId, planDate, onConnect, onChooseService, onChangeAi, onOpenNotices, onTurnOnStart, onPhone, onCheckKey, onOpenLocal,
  onSeePlan, onCheckAgain, bridge = onboarding, autostart = macAutostart, copy, zone, clock = Date.now }: CheckMySetupProps) {
  const { date } = useDay();
  const id = useId();
  const [facts, setFacts] = useState<CheckFacts | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const round = useRef(0);
  const alive = useRef(true);
  const run = async () => {
    const mine = ++round.current;
    setBusy(true); setCopied(null);
    const [check, notices, startOn] = await Promise.all([
      bridge.setupCheck(serviceTypeId, planId, planDate ?? undefined).catch(() => null),
      bridge.noticePermission().catch((): NoticePermission => "unknown"),
      autostart.get().then(on => on === true, () => null),
    ]);
    if (!alive.current || mine !== round.current) return;
    setFacts({ check, notices, startOn });
    setCheckedAt(clock());
    setBusy(false);
  };
  useEffect(() => {
    alive.current = true;
    void run();
    return () => { alive.current = false; };
    // One check when it opens; "Check again" runs the next.
  }, []);
  const rows = facts ? setupRows(facts, k, { date, zone }) : [];
  const handlers: Record<FixId, (() => void) | undefined> = {
    connect: onConnect, "connect-again": onConnect, retry: () => { onCheckAgain?.(); void run(); }, "choose-service": onChooseService, "choose-other": onChooseService,
    "change-ai": onChangeAi, "check-key": onCheckKey, "open-local": onOpenLocal, "see-plan": onSeePlan, "open-notices": onOpenNotices, "turn-on-start": onTurnOnStart, phone: onPhone,
  };
  const fixOf = (fix: FixId): { label: string; go: () => void } => {
    const go = handlers[fix];
    // Connecting another system names it ("Connect B1 Church").
    const label = fix === "connect" && k.system ? `Connect ${k.system.name}` : FIX_LABEL[fix];
    return go ? { label, go } : { label: FIX_LABEL["change-ai"], go: onChangeAi };
  };
  const copyReport = async () => {
    if (!facts) return;
    const text = reportFor(facts, k, rows, checkedAt);
    try {
      await (copy ?? (t => navigator.clipboard.writeText(t)))(text);
      setCopied("done");
    } catch { setCopied("failed"); }
  };
  return <section className="check-setup" aria-labelledby={`${id}-t`}>
    <h2 id={`${id}-t`} className="h3" tabIndex={-1}>{CHECK_TITLE}</h2>
    <p className="small check-status" role="status" aria-live="polite">{busy ? "Checking…" : checkedAt ? `Checked at ${time(checkedAt, zone)}.` : ""}</p>
    {rows.length > 0 && <ul className="check-rows">{rows.map(row => {
      const fix = row.fix ? fixOf(row.fix) : null;
      return <li key={row.id} className={`check-row${row.ok ? " is-ok" : row.code === "unknown" ? " is-unknown" : " is-needs"}`}>
        <span className="check-label">{row.label}</span>
        <span className="check-verdict"><Icon name={row.ok ? "check" : row.code === "unknown" ? "question" : "info"} small /><span>{row.verdict}</span></span>
        {fix && <button type="button" className="btn btn-secondary btn-sm check-fix" aria-label={`${fix.label}: ${row.label}`} onClick={fix.go}>{fix.label}</button>}
      </li>;
    })}</ul>}
    <div className="find-next check-acts">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { onCheckAgain?.(); void run(); }}>Check again</button>
      <button type="button" className="btn btn-secondary" disabled={!facts} onClick={() => { void copyReport(); }}>Copy a report</button>
    </div>
    {copied === "done" && <p className="small" role="status">{COPIED}</p>}
    {copied === "failed" && <p className="problem" role="alert">{COPY_FAILED}</p>}
  </section>;
}
