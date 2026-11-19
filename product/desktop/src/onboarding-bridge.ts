// The page's one door to the native commands the new onboarding added (docs/design/onboarding-native-contract.md, lanes
// N1–N8), so a change to that contract is a change to this file only. Commands that predate onboarding keep their own
// modules, which first run and the AI screens also use: connection.ts (Planning Center sign-in), model.ts (the AI route
// and Ozzie's AI) and background.ts (starting with the Mac). Every reply is untrusted IPC: it is checked
// here and reduced to closed codes, counts, ids and Planning Center's own names for services; native or provider text is
// never passed on. Keys never pass through here: the key is taken natively (a native window or the clipboard) and only a
// verdict comes back (spec S8c). A command native doesn't have yet rejects; each caller here names its fallback.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { ManagedAccount, ModelStatus } from "./model.js";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type Listen = <T>(event: string, handle: (payload: T) => void) => Promise<() => void>;

// ---- Small validators ---------------------------------------------------------------------------------------------

const plain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const id = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,31}$/u.test(v);
const count = (v: unknown, max = 1_000_000): number | null => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max ? v as number : null;
/** Display text from Planning Center (a service's or plan's own name): one line, no control or invisible characters, 120 at most. */
export function displayText(v: unknown, max = 120): string | null {
  if (typeof v !== "string") return null;
  const clean = v.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean ? [...clean].slice(0, max).join("") : null;
}
const instant = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const wallClock = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(v) && v.length <= 40;
const oneOf = <T extends string>(v: unknown, all: readonly T[]): T | null => typeof v === "string" && (all as readonly string[]).includes(v) ? v as T : null;
const zoneName = (v: unknown): string | null => typeof v === "string" && v.length <= 64 && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/u.test(v) ? v : null;
/** The closed reason a native read rejected with: `{"sunday-choices": "denied"}`, `"denied"`, or anything else as text. */
export const reasonOf = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (plain(error)) for (const v of Object.values(error)) if (typeof v === "string") return v;
  return JSON.stringify(error) ?? "";
};

// ---- Which service Ozzie watches (N3) -----------------------------------------------------------------------------

/** One upcoming plan. `sort_date` is Planning Center's local wall-clock time; `times` the plan's service starts as instants. */
export interface PlanOption { id: string; sort_date: string; title: string | null; series_title: string | null; times: string[] }
/** One service (a Planning Center service type) and its next plan; `next` null when nothing is planned. `problem`: its plans weren't read. */
export interface ServiceOption { id: string; name: string | null; next: PlanOption | null; problem: string | null }
export interface ServicePick { services: ServiceOption[]; time_zone: string | null; more: boolean }

export function parsePlan(v: unknown): PlanOption | null {
  if (!plain(v) || !id(v.id) || !wallClock(v.sort_date)) return null;
  const times = v.times_read === false || !Array.isArray(v.times) ? [] : v.times.filter(instant).slice(0, 12);
  return { id: v.id, sort_date: v.sort_date, title: displayText(v.title), series_title: displayText(v.series_title), times };
}
export function parsePick(v: unknown): ServicePick | null {
  if (!plain(v) || !Array.isArray(v.services)) return null;
  const services: ServiceOption[] = [];
  for (const s of v.services.slice(0, 100)) {
    if (!plain(s) || !id(s.id)) continue;
    const problem = s.problem === null || s.problem === undefined ? null : typeof s.problem === "string" && /^[a-z-]{1,40}$/u.test(s.problem) ? s.problem : "unreadable";
    services.push({ id: s.id, name: displayText(s.name), next: parsePlan(s.next), problem });
  }
  return { services, time_zone: zoneName(v.time_zone), more: v.more === true };
}

// ---- First-read progress (N4) ------------------------------------------------------------------------------------

export type ReadStage = "plan" | "teams" | "people" | "away" | "rules";
/** One stage starting or done, with a count only; never a name. */
export interface ReadProgress { stage: ReadStage; done: boolean; count: number | null }
export function parseProgress(v: unknown): ReadProgress | null {
  if (!plain(v)) return null;
  const stage = oneOf(v.stage, ["plan", "teams", "people", "away", "rules"] as const);
  const state = oneOf(v.state, ["start", "done"] as const);
  if (!stage || !state) return null;
  return { stage, done: state === "done", count: count(v.count, 100_000) };
}

// ---- Your church's own key (N5) ----------------------------------------------------------------------------------

export type Company = "openai" | "anthropic" | "gemini";
export const COMPANIES: readonly Company[] = ["openai", "anthropic", "gemini"];
export type KeyProvider = Company | "other";
/** One preset company, as providers.json holds it (spec S8a's cards). Texts are fixed data, checked to be plain. */
export interface Provider {
  id: Company; name: string; company: string; easiest: boolean; model: string;
  /** Only where the company's own page states it; null otherwise, and the guide then names no figure. */
  min_topup: string | null;
  /** Native gives none today: the page says no monthly figure unless native supplies one. */
  typical_month: string | null;
  retention_line: string | null; free_plan: boolean; checked_on: string | null;
  /** The release's live test passed for this company (decision 19). Only a literal `true` from native counts. */
  verified: boolean;
  /** Google: its free plan must not be suggested for church data; say "add billing first". */
  free_plan_not_for_church_data: boolean;
  /** Google: what happens on its free plan, as its terms say. */
  free_plan_line: string | null;
  /** Anthropic: the step the guide must add (choose a workspace; expiry Never). */
  key_note: string | null;
}
/** Fixed text from native, whole or not at all: longer than `max` is refused, never cut mid-sentence. */
const shortText = (v: unknown, max: number): string | null => {
  const t = displayText(v, max + 1);
  return t && [...t].length <= max ? t : null;
};
export function parseProviders(v: unknown): Provider[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 6).flatMap(p => {
    if (!plain(p)) return [];
    const pid = oneOf(p.id, COMPANIES), name = shortText(p.name, 40), company = shortText(p.company, 40), m = shortText(p.model, 80);
    if (!pid || !name || !company || !m) return [];
    return [{ id: pid, name, company, easiest: p.tag === "easiest", model: m, min_topup: shortText(p.min_topup, 20), typical_month: shortText(p.typical_month, 40),
      retention_line: shortText(p.retention_line, 400), free_plan: p.free_plan === true, checked_on: shortText(p.checked_on, 10), verified: p.verified_live === true,
      free_plan_not_for_church_data: p.free_plan_not_for_church_data === true, free_plan_line: shortText(p.free_plan_line, 400), key_note: shortText(p.key_note, 400) }];
  });
}
/** "ozzie-account" (ozzie.church/account: see the plan, update the card, cancel) and "ozzie-terms" are Ozzie's AI's pages (S10). */
export type HelpPage = `${Company}-${"sign-in" | "billing" | "keys" | "settings"}` | "ollama-download" | "ozzie-account" | "ozzie-terms";
export type KeyVerdict = "works" | "refused" | "no-credit" | "unreachable" | "wrong-kind" | "not-a-key" | "model-unavailable" | "slow-down" | "daily-limit"
  | "not-saved" | "empty" | "cancelled" | "too-many-checks" | "failed" | "needs-workspace" | "wrong-address" | "not-verified-yet" | "not-an-ai-key"
  // Native's re-check of each company's docs (2026-11-17): an admin key, a region the company refuses, a key limited to
  // some permissions, the company busy, a Google project to finish, Google refusing how the key was sent.
  | "admin-key" | "region" | "restricted-key" | "provider-busy" | "needs-project-setup" | "auth-conflict" | "confirm-unknown-shape"
  // Review F2: Google's free plan isn't offered in this country, so billing has to be on.
  | "needs-billing"
  // Contract 14: OpenAI says the account must belong to an organization first.
  | "needs-organization"
  // Review 2026-11-18: an Anthropic sign-in token (L-3b); a key that works, checked while another choice was made (M-2).
  | "sign-in-token" | "choice-changed"
  // "Use the key already on this Mac", with no key kept for that company any more (2026-11-18).
  | "no-kept-key"
  | "unavailable";
/** Every verdict native gives (own_key.rs `Verdict`; a native test reads this list and fails if one is missing). */
const KEY_VERDICTS: readonly KeyVerdict[] = ["works", "refused", "no-credit", "unreachable", "wrong-kind", "not-a-key", "model-unavailable", "slow-down",
  "daily-limit", "not-saved", "empty", "cancelled", "too-many-checks", "failed", "needs-workspace", "wrong-address", "not-verified-yet", "not-an-ai-key",
  "admin-key", "region", "restricted-key", "provider-busy", "needs-project-setup", "auth-conflict", "confirm-unknown-shape", "needs-billing", "needs-organization",
  "sign-in-token", "choice-changed", "no-kept-key"];
/** A company whose keys Ozzie recognises but doesn't offer as a card (native `OTHER_AI_PREFIXES`): only through Another AI company. */
export type OtherAi = "openrouter" | "xai" | "groq";
const OTHER_AIS: readonly OtherAi[] = ["openrouter", "xai", "groq"];
/**
 * What native said about a key, never the key. `looks_like`: with "wrong-kind", the company its shape belongs to; with
 * "admin-key", the company whose administrator's key it is (one of the three only; review L-3a).
 */
export interface KeyResult { verdict: KeyVerdict; looks_like?: Company | OtherAi; status?: ModelStatus }
export function parseKeyResult(v: unknown): KeyResult {
  if (typeof v === "string") return { verdict: oneOf(v, KEY_VERDICTS) ?? "unavailable" };
  if (!plain(v)) return { verdict: "unavailable" };
  const verdict = oneOf(v.verdict, KEY_VERDICTS) ?? "unavailable";
  const company = oneOf(v.looks_like, COMPANIES), other = company ?? oneOf(v.looks_like, OTHER_AIS);
  const looks = verdict === "wrong-kind" ? other : verdict === "admin-key" ? company : null;
  return { verdict, ...(looks ? { looks_like: looks } : {}), ...(verdict === "works" && plain(v.status) ? { status: v.status as unknown as ModelStatus } : {}) };
}
/**
 * Which companies a key of the church's own is kept for (N5 `own_key_saved`): one closed id per key, or null when the
 * reply is anything else (a host, any text), so nothing but these words ever comes back.
 */
export function parseSaved(v: unknown): KeyProvider[] | null {
  if (!Array.isArray(v) || v.length > 20) return null;
  const ids = v.map(x => oneOf(x, [...COMPANIES, "other"] as const));
  return ids.every(x => x !== null) ? ids as KeyProvider[] : null;
}
/** "Another AI company": the person's own https address and model name; presets carry none. */
export interface KeyTarget { provider: KeyProvider; baseUrl?: string; model?: string }
const keyArgs = (t: KeyTarget) => ({ provider: t.provider, ...(t.provider === "other" && t.baseUrl ? { baseUrl: t.baseUrl } : {}),
  ...(t.provider === "other" && t.model ? { model: t.model } : {}) });

// ---- AI on this Mac (N6) -----------------------------------------------------------------------------------------

export type LocalApp = "ollama" | "lm-studio";
export interface LocalModel { id: string; bytes: number | null; fits: boolean; recommended: boolean }
/** `start_hint`: native's own sentence for starting that app (LM Studio's server doesn't start by itself). */
/**
 * `models`: only models that run on this Mac. `elsewhere`: how many more the app lists that don't (Ollama's cloud models,
 * served from its servers) or that native can't tell do (native `on_this_mac`): never listed, only counted.
 */
export interface LocalAppState { app: LocalApp; installed: boolean; running: boolean; models: LocalModel[]; start_hint: string | null; elsewhere: number;
  /** Its own program is running, its server answering or not (native `open`). */
  open: boolean }
/** "too-small": no model Ozzie offers fits this Mac's memory (AI on this Mac needs 16 GB or more); native local_ai.rs `advice`. */
export type LocalAdvice = "too-small" | "medium" | "large" | "unknown";
/** The three models Ozzie can download and set up itself (native `local_models`), by size word. */
export type ModelSize = "small" | "medium" | "large";
/** Whether a model would fit on the disk where Ollama keeps models; "not-needed": it is on this Mac already. */
export type DiskRoom = "enough" | "not-enough" | "unknown" | "not-needed";
/**
 * One catalogue model as it stands on this Mac. `offered`: Ozzie downloads and sets it up (one that isn't is shown only
 * to remove Ozzie's own copy or download of it); `downloaded`: Ollama has it; `set_up`: Ozzie's own copy with room is
 * there; `downloaded_by_ozzie`: Ozzie downloaded it itself, so removing it deletes it too.
 */
export interface CatalogueModel { size: ModelSize; id: string; bytes: number; fits: boolean; offered: boolean; recommended: boolean; downloaded: boolean; set_up: boolean;
  disk: DiskRoom; downloaded_by_ozzie: boolean }
export interface LocalFound { memory_gb: number | null; advice: LocalAdvice | null; recommended: string | null; recommended_bytes: number | null; apps: LocalAppState[];
  /** Free space where Ollama keeps models, when native can tell. */
  free_bytes: number | null;
  /** Empty when native gives none (an older build): the page then keeps the person's own models only. */
  catalogue: CatalogueModel[] }
const modelId = (v: unknown): string | null => typeof v === "string" && /^[\w.:/@+-]{1,120}$/u.test(v) ? v : null;
const MODEL_SIZES = ["small", "medium", "large"] as const;
const DISK_ROOMS = ["enough", "not-enough", "unknown", "not-needed"] as const;
function parseCatalogue(v: unknown): CatalogueModel[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 3).flatMap(m => {
    if (!plain(m)) return [];
    const size = oneOf(m.size, MODEL_SIZES), mid = modelId(m.id), bytes = count(m.size_bytes, 2 ** 50);
    const disk = oneOf(m.disk, DISK_ROOMS) ?? "unknown";
    // A row native didn't say fits, or didn't say is offered, isn't offered: never a download the Mac can't hold or that fails.
    return size && mid && bytes !== null ? [{ size, id: mid, bytes, fits: m.fits === true, offered: m.offered === true, recommended: m.recommended === true, downloaded: m.downloaded === true,
      set_up: m.set_up === true, disk, downloaded_by_ozzie: m.downloaded_by_ozzie === true }] : [];
  });
}
export function parseLocal(v: unknown): LocalFound {
  const none = (app: LocalApp): LocalAppState => ({ app, installed: false, running: false, models: [], start_hint: null, elsewhere: 0, open: false });
  if (!plain(v)) return { memory_gb: null, advice: null, recommended: null, recommended_bytes: null, apps: [none("ollama"), none("lm-studio")], free_bytes: null, catalogue: [] };
  const apps = (["ollama", "lm-studio"] as const).map(app => {
    const a = (Array.isArray(v.apps) ? v.apps : []).find(x => plain(x) && x.app === app);
    if (!plain(a)) return none(app);
    const models = (Array.isArray(a.models) ? a.models : []).slice(0, 50).flatMap(m => {
      const mid = plain(m) ? modelId(m.id) : null;
      return mid && plain(m) ? [{ id: mid, bytes: count(m.size_bytes, 2 ** 50), fits: m.fits !== false, recommended: m.recommended === true }] : [];
    });
    return { app, installed: a.installed === true || a.running === true, running: a.running === true, models, start_hint: shortText(a.start_hint, 300),
      elsewhere: count(a.elsewhere, 1000) ?? 0, open: a.open === true || a.running === true };
  });
  return { memory_gb: count(v.memory_gb, 4096), advice: oneOf(v.advice, ["too-small", "medium", "large", "unknown"] as const), recommended: modelId(v.recommended),
    recommended_bytes: count(v.recommended_size_bytes, 2 ** 50), apps, free_bytes: count(v.free_bytes, 2 ** 53), catalogue: parseCatalogue(v.catalogue) };
}
/** The steps of "Download and set up" (native `Phase`). */
export type ModelPhase = "starting" | "downloading" | "verifying" | "finishing" | "setting-up" | "checking";
const MODEL_PHASES = ["starting", "downloading", "verifying", "finishing", "setting-up", "checking"] as const;
/** How it ended (native `End`); on "done" the check's own verdict is in `check`. */
export type ModelEnd = "done" | "cancelled" | "no-space" | "offline" | "not-found" | "stopped" | "stalled" | "failed" | "not-set-up";
const MODEL_ENDS = ["done", "cancelled", "no-space", "offline", "not-found", "stopped", "stalled", "failed", "not-set-up"] as const;
/** What the one download and set-up is doing, or how it ended: numbers and closed words only. */
export interface ModelProgress { model: string; phase: ModelPhase; done_bytes: number; total_bytes: number; end: ModelEnd | null; check: LocalCheck | null }
/** The most bytes the page shows (native local_models.rs `MAX_BYTES` says no more). */
const MAX_BYTES = 2 ** 50;
/** A byte count: larger ones are shown as the most, never dropped; anything that isn't a count is null. */
const bytes = (v: unknown): number | null => typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_BYTES) : null;
export function parseModelProgress(v: unknown): ModelProgress | null {
  if (!plain(v)) return null;
  const model = modelId(v.model), phase = oneOf(v.phase, MODEL_PHASES);
  const end = v.end === null || v.end === undefined ? null : oneOf(v.end, MODEL_ENDS) ?? "failed";
  // An ending always gets through, whatever its numbers say, so the page is never left at work (review L-3).
  const total = bytes(v.total_bytes) ?? (end !== null ? 0 : null), done = bytes(v.done_bytes) ?? (end !== null ? 0 : null);
  if (!model || !phase || total === null || done === null) return null;
  // The check's verdict, in the same closed words as "Check that it answers"; never the route's status.
  const check = end === "done" && plain(v.check) ? parseLocalCheck({ verdict: v.check.verdict, seconds: v.check.seconds, small_room: v.check.small_room }) : null;
  return { model, phase, done_bytes: Math.min(done, total), total_bytes: total, end, check };
}
/** Why a download couldn't start (native `Refusal`), or "unavailable" when native didn't say. */
export type DownloadRefusal = "busy" | "not-running" | "too-big" | "no-room" | "not-in-catalogue" | "not-offered" | "unavailable";
const DOWNLOAD_REFUSALS = ["busy", "not-running", "too-big", "no-room", "not-in-catalogue", "not-offered"] as const;
/** How "Remove this model from this Mac" ended (native `Removed`), or why it couldn't run. */
export type ModelRemoved = "removed" | "none" | "stopped" | "failed" | "busy";
const MODEL_REMOVED = ["removed", "none", "stopped", "failed"] as const;
/** The model event's name (native `MODEL_EVENT`). */
export const MODEL_EVENT = "ozzie:local-model";
/**
 * "choice-changed": it answers, but another choice of AI was made while it was checked, so it wasn't chosen (review M-2).
 * "not-on-this-mac": the app lists it, but it runs elsewhere (Ollama's cloud models), so nothing was asked of it.
 */
export type LocalVerdict = "answers" | "no-tools" | "lost-start" | "small-context" | "thinks-too-long" | "lookup-instead" | "too-slow" | "stopped" | "not-found"
  | "not-on-this-mac" | "choice-changed" | "unavailable";
/**
 * `seconds`: how long the first question took, on `answers`, and on `too-slow` when the second one timed out.
 * `small_room`: on `answers` only, the app gave the model less room than Ozzie's longer questions need (B-2).
 */
export interface LocalCheck { verdict: LocalVerdict; seconds?: number; status?: ModelStatus; small_room?: true }
/** Every verdict native gives (local_ai.rs `Verdict`; a native test reads this list and fails if one is missing). */
const LOCAL_VERDICTS = ["answers", "no-tools", "lost-start", "small-context", "thinks-too-long", "lookup-instead", "too-slow", "stopped", "not-found",
  "not-on-this-mac", "choice-changed"] as const;
export function parseLocalCheck(v: unknown): LocalCheck {
  if (!plain(v)) return { verdict: oneOf(v, LOCAL_VERDICTS) ?? "unavailable" };
  const verdict = oneOf(v.verdict, LOCAL_VERDICTS) ?? "unavailable";
  const seconds = count(v.seconds, 3600);
  const timed = verdict === "answers" || verdict === "too-slow";
  return { verdict, ...(timed && seconds !== null ? { seconds } : {}), ...(verdict === "answers" && plain(v.status) ? { status: v.status as unknown as ModelStatus } : {}),
    ...(verdict === "answers" && v.small_room === true ? { small_room: true as const } : {}) };
}

// ---- Getting Ollama itself (contract N6 "Ozzie gets Ollama"; native ollama_install.rs) -----------------------------

/** The steps of "Download Ollama and set it up" (native `Phase`; a native test reads this list and fails if one is missing). */
export type OllamaPhase = "starting" | "downloading" | "checking" | "installing" | "opening" | "still-starting";
const OLLAMA_PHASES = ["starting", "downloading", "checking", "installing", "opening", "still-starting"] as const;
/** How it ended (native `End`). */
export type OllamaEnd = "ready" | "cancelled" | "offline" | "redirected" | "too-large" | "stalled" | "download-failed" | "no-room" | "bad-archive"
  | "not-signed" | "wrong-team" | "wrong-app" | "not-notarized" | "outdated" | "already-installed" | "cant-install" | "install-failed" | "wont-open"
  | "not-answering" | "failed";
const OLLAMA_ENDS = ["ready", "cancelled", "offline", "redirected", "too-large", "stalled", "download-failed", "no-room", "bad-archive",
  "not-signed", "wrong-team", "wrong-app", "not-notarized", "outdated", "already-installed", "cant-install", "install-failed", "wont-open",
  "not-answering", "failed"] as const;
/** Why it couldn't start (native `Refusal`); "unsupported": this build's native side doesn't get Ollama, so today's guide shows. */
export type OllamaRefusal = "busy" | "too-small" | "already-installed" | "already-running" | "unavailable";
const OLLAMA_REFUSALS = ["busy", "too-small", "already-installed", "already-running", "unavailable"] as const;
/** What the one job is doing, or how it ended: numbers and closed words only. `total_bytes` is 0 until the download said its size. */
export interface OllamaProgress { phase: OllamaPhase; done_bytes: number; total_bytes: number; end: OllamaEnd | null }
/** The download is capped at a gigabyte natively (`MAX_DOWNLOAD_BYTES`). */
const OLLAMA_MAX = 1_000_000_000;
export function parseOllamaProgress(v: unknown): OllamaProgress | null {
  if (!plain(v)) return null;
  const phase = oneOf(v.phase, OLLAMA_PHASES);
  const end = v.end === null || v.end === undefined ? null : oneOf(v.end, OLLAMA_ENDS) ?? "failed";
  const total = count(v.total_bytes, OLLAMA_MAX) ?? 0, done = count(v.done_bytes, OLLAMA_MAX) ?? 0;
  // An ending always gets through, whatever its numbers, so the page is never left at work.
  if (!phase) return end === null ? null : { phase: "starting", done_bytes: 0, total_bytes: 0, end };
  return { phase, done_bytes: Math.min(done, total), total_bytes: total, end };
}
/** The event native sends at each step (native `OLLAMA_EVENT`). */
export const OLLAMA_EVENT = "ozzie:ollama-install";
/** "Show Ollama in Finder" (native `ollama_reveal`). */
export type OllamaReveal = "shown" | "not-there" | "finder-unavailable" | "busy";
const OLLAMA_REVEALS = ["not-there", "finder-unavailable", "busy"] as const;
/** What Ozzie did: each ending's time and word, oldest first; `installed_at_ms` while an Ollama Ozzie installed is in Applications. */
export interface OllamaHistory { done: { at_ms: number; end: OllamaEnd }[]; installed_at_ms: number | null }
export function parseOllamaHistory(v: unknown): OllamaHistory | null {
  if (!plain(v)) return null;
  const done = (Array.isArray(v.done) ? v.done : []).slice(-20).flatMap(d => {
    const at = plain(d) ? count(d.at_ms, 2 ** 52) : null, end = plain(d) ? oneOf(d.end, OLLAMA_ENDS) : null;
    return at !== null && end ? [{ at_ms: at, end }] : [];
  });
  return { done, installed_at_ms: count(v.installed_at_ms, 2 ** 52) };
}

// ---- Ozzie's AI (N7, with the website's offer W6) ------------------------------------------------------------------

/** What ozzie.church offers now. Closed: "Not open for sign-up yet"; unreachable: "Can't check just now". */
export interface Offer { open: boolean; price_text: string | null; answers_text: string | null; reason: "closed" | "unreachable" | null }
const offerText = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 60 && /^[A-Za-z0-9 $.,-]+$/u.test(v) ? v : null;
export function parseOffer(v: unknown): Offer {
  const shut = (reason: "closed" | "unreachable"): Offer => ({ open: false, price_text: null, answers_text: null, reason });
  // Nothing readable came back: Ozzie couldn't tell, so it doesn't say sign-up is closed.
  if (!plain(v)) return shut("unreachable");
  if (v.open !== true) return shut(v.reason === "unreachable" ? "unreachable" : "closed");
  if (v.plan !== "personal") return shut("closed");
  const price_text = offerText(v.price_text), answers_text = offerText(v.answers_text);
  return price_text && answers_text ? { open: true, price_text, answers_text, reason: null } : shut("closed");
}
/** When Ozzie's AI's pause ends, if the account says (`paused_until`, an instant); null otherwise. */
export const pausedUntil = (account: unknown): string | null =>
  plain(account) && typeof account.paused_until === "string" && account.paused_until.length <= 40 && Number.isFinite(Date.parse(account.paused_until)) ? account.paused_until : null;
export type PlanReason = "payment-failed" | "cancelled" | "none" | null;
export const planReason = (account: unknown): PlanReason => plain(account) ? oneOf(account.plan_reason, ["payment-failed", "cancelled", "none"] as const) : null;
/** How a paid connect ended, from its closed `ManagedError` code (native hosted.rs). */
/** `not-finished`: a paid connect heard nothing back in its hour (contract N7). */
export type PaidEnd = "payment-cancelled" | "cancelled" | "expired" | "not-finished" | "busy" | "browser-unavailable" | "refused" | "keychain" | "unreachable";
export const paidEnd = (error: unknown): PaidEnd =>
  oneOf(reasonOf(error), ["payment-cancelled", "cancelled", "expired", "not-finished", "busy", "browser-unavailable", "refused", "keychain"] as const) ?? "unreachable";

// ---- Check my setup (setup_check) and notices (N8) ----------------------------------------------------------------

export type NoticePermission = "allowed" | "denied" | "not-asked" | "unknown";
export interface SetupCheck {
  planning_center: "connected" | "sign-in-again" | "unreachable" | "not-connected";
  church: string | null; checked_at_ms: number | null;
  service: "watching" | "passed" | "waiting" | "none" | "unknown";
  ai: "ready" | "none" | "no-key" | "not-checked" | "not-on-this-mac" | "month-limit" | "paused" | "not-connected" | "reconnect" | "unknown";
  ai_route: "managed" | "own" | "local" | "none";
  ai_provider: Company | null;
  notices: NoticePermission;
  start_with_mac: "on" | "off" | "unknown";
  /** Native's plain-text report, codes only. Kept only if every line is a known `key: code` shape (setup-report.ts checks). */
  report: string;
}
export function parseSetupCheck(v: unknown): SetupCheck | null {
  if (!plain(v)) return null;
  const pc = oneOf(v.planning_center, ["connected", "sign-in-again", "unreachable", "not-connected"] as const);
  if (!pc) return null;
  return {
    planning_center: pc, church: displayText(v.church), checked_at_ms: count(v.checked_at_ms, 2 ** 52),
    service: oneOf(v.service, ["watching", "passed", "waiting", "none", "unknown"] as const) ?? "unknown",
    ai: oneOf(v.ai, ["ready", "none", "no-key", "not-checked", "not-on-this-mac", "month-limit", "paused", "not-connected", "reconnect"] as const) ?? "unknown",
    ai_route: oneOf(v.ai_route, ["managed", "own", "local", "none"] as const) ?? "none",
    ai_provider: oneOf(v.ai_provider, COMPANIES),
    notices: oneOf(v.notices, ["allowed", "denied", "not-asked", "unknown"] as const) ?? "unknown",
    start_with_mac: oneOf(v.start_with_mac, ["on", "off", "unknown"] as const) ?? "unknown",
    report: typeof v.report === "string" ? v.report.slice(0, 4000) : "",
  };
}
/** The notice's day for `notify_sunday_attention` (N8): a weekday, "weekend" or "service". Never text. */
export type NoticeDay = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "weekend" | "service";

// ---- The bridge --------------------------------------------------------------------------------------------------

/** A native command this build doesn't have yet: Tauri rejects an unknown command with text naming it. */
export const missingCommand = (error: unknown): boolean => /not found|unknown command|fake-bridge/iu.test(reasonOf(error));

export function createOnboardingBridge(invoke: Invoke = tauriInvoke as Invoke, listen: Listen = (e, h) => tauriListen(e, x => h(x.payload as never))) {
  const on = <T,>(event: string, parse: (v: unknown) => T | null, handle: (v: T) => void): () => void => {
    let stop: (() => void) | null = null, stopped = false;
    // Stopping never throws: a listener that can't be removed (the window closing) only stops being heard.
    const quietly = (f: () => void) => { try { f(); } catch { /* nothing more to stop */ } };
    void listen<unknown>(event, raw => { if (!stopped) { const v = parse(raw); if (v !== null) handle(v); } })
      .then(f => { if (stopped) quietly(f); else stop = f; }, () => undefined);
    return () => { stopped = true; if (stop) quietly(stop); };
  };
  const listPlans = async (serviceTypeId: string) => {
    const plans = await invoke<{ items?: unknown }>("list_upcoming_plans", { serviceTypeId });
    return (Array.isArray(plans?.items) ? plans.items : []).map(parsePlan).filter((p): p is PlanOption => p !== null);
  };
  return {
    /**
     * Which services this church has, each with its next plan (N3 `pick_service`), ordered soonest first by native. Until
     * native has it: the two picker reads Ozzie already has (`list_service_types`, then `list_upcoming_plans` for each,
     * one at a time), with no service times, ordered here the same way.
     */
    async pickService(): Promise<ServicePick> {
      try {
        const reply = parsePick(await invoke<unknown>("pick_service"));
        if (reply) return reply;
        throw "invalid-response";
      } catch (error) {
        if (!missingCommand(error)) throw error;
      }
      const types = await invoke<{ items?: unknown; more?: unknown }>("list_service_types");
      const services: ServiceOption[] = [];
      for (const t of (Array.isArray(types?.items) ? types.items : []).slice(0, 25)) {
        if (!plain(t) || !id(t.id)) continue;
        try { services.push({ id: t.id, name: displayText(t.name), next: (await listPlans(t.id))[0] ?? null, problem: null }); }
        catch (error) {
          if (reasonOf(error) === "denied") throw error;
          services.push({ id: t.id, name: displayText(t.name), next: null, problem: "unreadable" });
        }
      }
      const order = services.map((s, i) => ({ s, i }));
      order.sort((a, b) => a.s.next && b.s.next ? a.s.next.sort_date.localeCompare(b.s.next.sort_date) || a.i - b.i : a.s.next ? -1 : b.s.next ? 1 : a.i - b.i);
      return { services: order.map(x => x.s), time_zone: null, more: types?.more === true };
    },
    /** Up to 12 upcoming plans of one service ("Choose a different one"); unchanged native `list_upcoming_plans`. */
    upcomingPlans: listPlans,
    /** The first plan of a service after a date that has passed (N3 `next_plan`); null when none is planned. Fallback: the picker read. */
    async nextPlan(serviceTypeId: string, afterDate: string): Promise<PlanOption | null> {
      try { return parsePlan(await invoke<unknown>("next_plan", { serviceTypeId, afterDate })); }
      catch (error) {
        if (!missingCommand(error)) throw error;
        return (await listPlans(serviceTypeId)).find(p => p.sort_date.slice(0, 10) > afterDate) ?? null;
      }
    },
    /** First-read progress (N4 `ozzie:check-progress`): stages and counts. Returns a function that stops listening. */
    onProgress: (handle: (p: ReadProgress) => void) => on("ozzie:check-progress", parseProgress, handle),
    /** Ozzie came back to the front after a sign-in or a payment (N1 `ozzie:signed-in`). */
    onSignedIn: (handle: () => void) => on("ozzie:signed-in", () => true, handle),

    // Your church's own key (N5): the key is taken natively; the page sees only the verdict.
    providers: async (): Promise<Provider[]> => { try { return parseProviders(await invoke<unknown>("own_key_providers")); } catch { return []; } },
    openHelpPage: (page: HelpPage) => invoke<void>("open_help_page", { page }),
    /** The native "Paste your key" window; absent until native builds it (`unavailable`: offer the clipboard instead). */
    enterKey: async (target: KeyTarget): Promise<KeyResult> => {
      try { return parseKeyResult(await invoke<unknown>("own_key_enter", keyArgs(target))); }
      catch (error) { return { verdict: missingCommand(error) ? "unavailable" : parseKeyResult(reasonOf(error)).verdict }; }
    },
    /** Native reads the clipboard once, holds it, checks it, and clears the clipboard on "works" if it still holds the key. */
    pasteKey: async (target: KeyTarget): Promise<KeyResult> => {
      try { return parseKeyResult(await invoke<unknown>("own_key_paste", keyArgs(target))); }
      catch (error) { return { verdict: missingCommand(error) ? "unavailable" : parseKeyResult(reasonOf(error)).verdict }; }
    },
    /** Checks the key native already holds again (after adding credit, or with the company its shape belongs to). */
    checkKeyAgain: async (target: KeyTarget): Promise<KeyResult> => {
      try { return parseKeyResult(await invoke<unknown>("own_key_check_again", keyArgs(target))); }
      catch (error) { return { verdict: missingCommand(error) ? "unavailable" : parseKeyResult(reasonOf(error)).verdict }; }
    },
    /**
     * "Use the key already on this Mac": native reads the key it kept for this company, checks it as a pasted key, and
     * on "works" chooses it. Only the verdict comes back, never the key.
     */
    useKeptKey: async (provider: Company): Promise<KeyResult> => {
      try { return parseKeyResult(await invoke<unknown>("own_key_use_kept", { provider })); }
      catch (error) { return { verdict: missingCommand(error) ? "unavailable" : parseKeyResult(reasonOf(error)).verdict }; }
    },
    /** Drops the key native holds; called when the key screen closes. */
    forgetKey: () => invoke<void>("own_key_forget").catch(() => undefined),
    removeKey: () => invoke<ModelStatus>("own_key_remove"),
    /** "No AI for now": no route, so no AI request goes anywhere; a church's key and Ozzie's AI's sign-in stay (contract N5). */
    setNoAi: () => invoke<ModelStatus>("set_no_ai"),
    /** "Remove my key from this Mac": every key of the church's own that Ozzie knows of, whatever route is chosen. */
    removeOwnKey: async (): Promise<{ removed: "removed" | "none" | "refused"; status: ModelStatus | null }> => {
      const v = await invoke<unknown>("remove_own_key");
      const removed = plain(v) ? oneOf(v.removed, ["removed", "none", "refused"] as const) : null;
      return { removed: removed ?? "refused", status: plain(v) && plain(v.status) ? v.status as unknown as ModelStatus : null };
    },
    /** Which companies' keys "Remove my key from this Mac" would remove (`own_key_saved`); null when native can't say. */
    savedKeys: async (): Promise<KeyProvider[] | null> => { try { return parseSaved(await invoke<unknown>("own_key_saved")); } catch { return null; } },
    /**
     * How many keys of the church's own "Remove my key from this Mac" would remove now (`own_key_count`, from the
     * Keychain's list alone: no key is read; review L-4). Null when native can't say.
     */
    keptKeys: async (): Promise<number | null> => { try { return count(await invoke<unknown>("own_key_count"), 1000); } catch { return null; } },
    setMonthLimit: (limit: number) => invoke<ModelStatus>("set_month_limit", { limit: Math.max(100, Math.min(20_000, Math.round(limit))) }),

    // AI on this Mac (N6): what is there, the person's own models and their check, and the three models Ozzie downloads
    // and sets up itself (owner's request, 2026-11-18). A model is named only by a catalogue id native gave.
    findLocal: async (): Promise<LocalFound> => parseLocal(await invoke<unknown>("local_ai_find")),
    openLocal: (app: LocalApp) => invoke<void>("local_ai_open", { app }),
    /** Ozzie's window to the front again (after "Open Ollama", once Ollama answers). Never fails the page. */
    comeForward: () => invoke<void>("come_forward").catch(() => undefined),
    checkLocal: async (app: LocalApp, model: string): Promise<LocalCheck> => {
      try { return parseLocalCheck(await invoke<unknown>("local_ai_check", { app, model })); }
      catch (error) { return { verdict: missingCommand(error) ? "unavailable" : parseLocalCheck(reasonOf(error)).verdict }; }
    },
    /** "Download and set up" / "Set up": the first step, or why it couldn't start. The rest comes by `onModelProgress`. */
    downloadModel: async (model: string): Promise<{ progress: ModelProgress } | { refused: DownloadRefusal }> => {
      try {
        const progress = parseModelProgress(await invoke<unknown>("local_model_download", { model }));
        return progress ? { progress } : { refused: "unavailable" };
      } catch (error) { return { refused: oneOf(reasonOf(error), DOWNLOAD_REFUSALS) ?? "unavailable" }; }
    },
    /** Where the download got to, or how the last one ended (after the window was closed and opened again). */
    modelProgress: async (): Promise<ModelProgress | null> => { try { return parseModelProgress(await invoke<unknown>("local_model_progress")); } catch { return null; } },
    /** "Stop the download". */
    stopDownload: () => invoke<boolean>("local_model_cancel").then(() => undefined, () => undefined),
    /** "Remove this model from this Mac", after the page's confirm. `routeCleared`: AI on this Mac was this model, so none is chosen now. */
    removeModel: async (model: string): Promise<{ removed: ModelRemoved; routeCleared: boolean }> => {
      try {
        const v = await invoke<unknown>("local_model_remove", { model });
        return { removed: plain(v) ? oneOf(v.removed, MODEL_REMOVED) ?? "failed" : "failed", routeCleared: plain(v) && v.route_cleared === true };
      } catch (error) { return { removed: reasonOf(error) === "busy" ? "busy" : "failed", routeCleared: false }; }
    },
    /** Each step and the bytes of the download under way. Returns a function that stops listening. */
    onModelProgress: (handle: (p: ModelProgress) => void) => on(MODEL_EVENT, parseModelProgress, handle),

    // Getting Ollama itself (N6 "Ozzie gets Ollama"): only after the person presses "Download Ollama and set it up".
    /** The first step, or why it couldn't start; "unsupported" when this build's native side can't (today's guide then). */
    installOllama: async (): Promise<{ progress: OllamaProgress } | { refused: OllamaRefusal | "unsupported" }> => {
      try {
        const progress = parseOllamaProgress(await invoke<unknown>("ollama_install"));
        return progress ? { progress } : { refused: "unavailable" };
      } catch (error) { return { refused: missingCommand(error) ? "unsupported" : oneOf(reasonOf(error), OLLAMA_REFUSALS) ?? "unavailable" }; }
    },
    /** Where getting Ollama got to, or how the last one ended (after the window was closed and opened again). */
    ollamaProgress: async (): Promise<OllamaProgress | null> => { try { return parseOllamaProgress(await invoke<unknown>("ollama_install_progress")); } catch { return null; } },
    /** "Stop the download": the partial file is deleted and nothing is installed. */
    stopOllama: () => invoke<boolean>("ollama_install_cancel").then(() => undefined, () => undefined),
    /** "Show Ollama in Finder": the checked app Ozzie kept, when Applications needed a password. */
    revealOllama: async (): Promise<OllamaReveal> => {
      try { await invoke<unknown>("ollama_reveal"); return "shown"; } catch (error) { return oneOf(reasonOf(error), OLLAMA_REVEALS) ?? "not-there"; }
    },
    /** What Ozzie did, for What happened and Settings; null when native can't say. */
    ollamaHistory: async (): Promise<OllamaHistory | null> => { try { return parseOllamaHistory(await invoke<unknown>("ollama_install_history")); } catch { return null; } },
    /** Each step and the bytes of getting Ollama. Returns a function that stops listening. */
    onOllamaProgress: (handle: (p: OllamaProgress) => void) => on(OLLAMA_EVENT, parseOllamaProgress, handle),

    // Ozzie's AI (N7, with W6).
    offer: async (): Promise<Offer> => { try { return parseOffer(await invoke<unknown>("managed_offer")); } catch { return parseOffer(null); } },
    /** The one browser trip: sign in, pay, come back (an hour). Resolves with the account; rejects with a `PaidEnd` code. */
    payAndConnect: () => invoke<ManagedAccount>("managed_connect", { plan: "personal" }),
    cancelPay: () => invoke<void>("managed_connect_cancel"),
    /** "Open the page again" during the paid wait: the waiting attempt's own page (contract item 3); rejects "no-attempt" when none waits. */
    reopenPay: () => invoke<void>("managed_connect_reopen"),
    /** A fresh read of the account, for the 5-second poll while a payment turns Ozzie's AI on. */
    accountNow: () => invoke<ManagedAccount & { plan_reason?: unknown }>("managed_account_now"),

    // Check my setup and notices (N8).
    /** `planDate`: the watched plan's local date (YYYY-MM-DD), so "passed" means passed (contract L7). */
    setupCheck: async (serviceTypeId?: string, planId?: string, planDate?: string): Promise<SetupCheck | null> => {
      const date = planDate && /^\d{4}-\d{2}-\d{2}$/u.test(planDate) ? { planDate } : {};
      try { return parseSetupCheck(await invoke<unknown>("setup_check", { ...(serviceTypeId ? { serviceTypeId } : {}), ...(planId ? { planId } : {}), ...date })); }
      catch { return null; }
    },
    /**
     * Whether rooms, follow-ups and group events are read (native's own switch: a People grant for To never turns them
     * on; first-run review H1). Settings' "Also check rooms, follow-ups and group events" sets it.
     */
    operationsReads: async (): Promise<boolean | null> => { try { return (await invoke<unknown>("operations_reads")) === true; } catch { return null; } },
    /**
     * `pressed`: a person pressed a button for it just now. Otherwise the page asks after a sign-in, and native turns it
     * on only when that sign-in was started for these reads and granted them (main.rs `reads_may_go_on`; review M1).
     */
    setOperationsReads: async (on: boolean, pressed: boolean): Promise<boolean> => (await invoke<unknown>("set_operations_reads", { on, pressed })) === true,
    /** System Settings' Notifications pane (this build can't tell whether Ozzie's notices are allowed: contract N8). */
    openNoticeSettings: () => invoke<void>("open_notification_settings"),
    noticePermission: async (): Promise<NoticePermission> => {
      try { return oneOf(await invoke<unknown>("notification_permission"), ["allowed", "denied", "not-asked"] as const) ?? "unknown"; }
      catch { return "unknown"; }
    },
  };
}
export type OnboardingBridge = ReturnType<typeof createOnboardingBridge>;
/** The app's bridge. Tests build their own with `createOnboardingBridge(fakeInvoke, fakeListen)` (test/onboarding-fakes.ts). */
export const onboarding: OnboardingBridge = createOnboardingBridge();
