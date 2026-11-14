import { invoke } from "@tauri-apps/api/core";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";

export interface RecordingSummary { path_id: string; plan_id: string; completed_at: string }

/** Native Sunday reads. Every read is a GET inside the native allowlist; nothing here can change Planning Center. */
export const sundaySource = {
  check: (serviceTypeId: string, planId: string) => invoke<SundayCapture>("check_sunday", { serviceTypeId, planId }),
  /** Saved recordings are bound to one organization; another org's recordings are never listed or loaded. */
  recordings: (organization: string) => invoke<RecordingSummary[]>("list_sunday_recordings", { organization }),
  loadRecording: (organization: string, pathId: string) => invoke<SundayCapture>("load_sunday_recording", { organization, pathId }),
  deleteRecordings: (organization: string) => invoke<void>("delete_sunday_recordings", { organization }),
  /** Debug builds only: non-secret IDs from the developer's local settings; release builds return empty strings. */
  devDefaults: () => invoke<{ clientId: string; organization: string; serviceTypeId: string; planId: string; autopilot: boolean; autopilotOperations?: boolean }>("dev_defaults"),
};

export interface Settings { clientId: string; organization: string; serviceTypeId: string; planId: string }
const SETTINGS = "ozzie.settings.v1", RULES = "ozzie.rules.v1";
export const defaultRules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };

function load<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) as T } : fallback; }
  catch { return fallback; }
}
function save(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* per-device convenience only */ } }
export const loadSettings = () => load<Settings>(SETTINGS, { clientId: "", organization: "", serviceTypeId: "", planId: "" });
export const saveSettings = (s: Settings) => save(SETTINGS, s);
export const loadRules = () => load<SundayRules>(RULES, defaultRules);
export const saveRules = (r: SundayRules) => save(RULES, r);

/** Fixed local copy only. Native error text is never rendered. */
export function sundayProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("not-connected") || known.includes("missing-credentials") || known.includes("invalid-credentials")) return "Connect Planning Center first. Ozzie only reads; it changes nothing there.";
  if (known.includes("rate-limited")) return "Planning Center asked Ozzie to slow down. Wait a minute, then check again, or use the saved recording.";
  if (known.includes("denied")) return "Planning Center didn't allow this read. The signed-in account may not have access to this Sunday.";
  if (known.includes("organization")) return "The connected organization couldn't be verified, so nothing was read.";
  return "Planning Center couldn't be checked just now. You can use the last saved recording instead.";
}
