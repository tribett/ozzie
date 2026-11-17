import { invoke } from "@tauri-apps/api/core";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { backgroundCheckTeamIds } from "../../../core/src/kids-rules.js";
import { checkInsEvent, formIdsForCheck } from "../../../core/src/church-reads/rules.js";

export interface RecordingSummary { path_id: string; plan_id: string; completed_at: string }
/** Setup's Sunday picker (native sunday_picker.rs). Names and titles are display text for this Mac only. */
export interface ServiceTypeChoice { id: string; name: string | null }
/** `sort_date` is Planning Center's local wall-clock time with a misleading `Z`. */
export interface PlanChoice { id: string; sort_date: string; dates: string | null; title: string | null; series_title: string | null }
export interface Choices<T> { items: T[]; more: boolean }

/** Native Sunday reads. Every read is a GET inside the native allowlist; nothing here can change Planning Center. */
export const sundaySource = {
  /**
   * Every check (Check now, the schedule, always-on) passes this Mac's Church rules: the kids teams whose
   * scheduled people's background checks are read, only while that rule is on. None set, none read. The People forms
   * to watch go too, once forms are turned on (none: the list only); while forms are off, no form is read. So does the
   * Check-Ins event chosen on Church rules, which is then the only one read.
   */
  check: (serviceTypeId: string, planId: string, rules: SundayRules = loadRules()) => {
    const kidsTeamIds = backgroundCheckTeamIds(rules);
    const formIds = formIdsForCheck(rules), checkinsEventId = checkInsEvent(rules);
    return invoke<SundayCapture>("check_sunday", { serviceTypeId, planId, ...(kidsTeamIds.length ? { kidsTeamIds } : {}), ...(formIds ? { formIds } : {}),
      ...(checkinsEventId ? { checkinsEventId } : {}) });
  },
  /** Choosing the Sunday in setup: the church's service types, then one type's upcoming plans. Nothing is saved natively. */
  serviceTypes: () => invoke<Choices<ServiceTypeChoice>>("list_service_types"),
  upcomingPlans: (serviceTypeId: string) => invoke<Choices<PlanChoice>>("list_upcoming_plans", { serviceTypeId }),
  /** Saved recordings are bound to one organization; another org's recordings are never listed or loaded. */
  recordings: (organization: string) => invoke<RecordingSummary[]>("list_sunday_recordings", { organization }),
  loadRecording: (organization: string, pathId: string) => invoke<SundayCapture>("load_sunday_recording", { organization, pathId }),
  deleteRecordings: (organization: string) => invoke<void>("delete_sunday_recordings", { organization }),
  /** Debug builds only: non-secret IDs from the developer's local settings; release builds return empty strings. */
  devDefaults: () => invoke<{ clientId: string; organization: string; serviceTypeId: string; planId: string; autopilot: boolean; autopilotOperations?: boolean; autopilotOneClick?: boolean; kidsTeams?: string;
    autopilotCheckIns?: boolean; autopilotRegistrations?: boolean; forms?: string }>("dev_defaults"),
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

/** Why the Sunday picker couldn't list anything. Fixed local copy only; native error text is never rendered. */
export function choicesProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("not-connected") || known.includes("missing-credentials") || known.includes("invalid-credentials")) return "Connect Planning Center first. Then your upcoming Sundays are listed here.";
  if (known.includes("rate-limited")) return "Planning Center asked Ozzie to slow down. Try again in a minute, or enter the plan by hand.";
  if (known.includes("busy")) return "Ozzie is reading Planning Center for something else right now. Try again in a moment.";
  if (known.includes("denied")) return PICKER_REFUSED;
  if (known.includes("organization")) return "The connected organization couldn't be verified, so nothing was read.";
  return "Planning Center couldn't be read just now. Try again, or enter the plan by hand.";
}

/**
 * Planning Center refused a read (native "denied": its 401 or 403, which native code doesn't tell apart). Ozzie always
 * asks for Services at sign-in, so what is left is one of two causes it can't tell apart from here: the login signed in
 * with can't see that service type, or that sign-in is no longer accepted (audit item 5). Said as "one of these", with
 * who can give access and the next step.
 */
export const REFUSED = {
  summary: "Planning Center didn't let Ozzie read this Sunday.",
  either: "It's one of these, and Ozzie can't tell which from here:",
  login: "The Planning Center login you signed in with can't see this service type's plans. A Planning Center administrator at your church can give that login access to it in Planning Center Services.",
  signIn: "That sign-in is no longer accepted. Signing in again fixes this.",
  next: "Then sign in again, or choose a Sunday this login can see.",
  signInButton: "Open Settings to sign in again",
  chooseButton: "Open Settings to choose another Sunday",
} as const;
export const PICKER_REFUSED = "Planning Center didn't let Ozzie list your church's plans. Either the login you signed in with can't see Planning Center Services, or that sign-in is no longer accepted. A Planning Center administrator at your church can give your login access to Services; then sign in again. You can also enter a plan by hand.";
/** Whether a failed check was a refused read (REFUSED), so the Sunday page can offer its next steps. */
export const refusedRead = (error: unknown): boolean => {
  const known = JSON.stringify(error) ?? "";
  return known.includes("denied") && !known.includes("not-connected") && !known.includes("missing-credentials") && !known.includes("invalid-credentials");
};

/** Fixed local copy only. Native error text is never rendered. */
export function sundayProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("not-connected") || known.includes("missing-credentials") || known.includes("invalid-credentials")) return "Connect Planning Center first. Ozzie only reads; it changes nothing there.";
  if (known.includes("rate-limited")) return "Planning Center asked Ozzie to slow down. Wait a minute, then check again, or show the last saved check.";
  if (known.includes("denied")) return `${REFUSED.summary} Either the login you signed in with can't see this service type's plans, or that sign-in is no longer accepted. A Planning Center administrator at your church can give your login access; then sign in again under Settings, or choose another Sunday.`;
  if (known.includes("organization")) return "The connected organization couldn't be verified, so nothing was read.";
  return "Planning Center couldn't be checked just now. You can show the last saved check instead.";
}
