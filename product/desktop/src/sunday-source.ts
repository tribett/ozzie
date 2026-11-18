import { invoke } from "@tauri-apps/api/core";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { backgroundCheckTeamIds } from "../../../core/src/kids-rules.js";
import { checkInsEvent, formIdsForCheck } from "../../../core/src/church-reads/rules.js";
import { promise } from "./promises.js";

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

/** What comes after a sign-in that wasn't renewed, for each cause (`notRenewed`). */
interface NotRenewedNext { again: string; reached: string; locked: string; denied: string; unavailable: string; later: string }
/**
 * A read found Ozzie's sign-in to Planning Center needed renewing (its access lasts about two hours: running out by
 * Ozzie's clock, or already refused by Planning Center) and couldn't renew it first, so nothing was read (native main.rs
 * `renewed_auth`, core `renewal_error`), with `what` happened instead and `next`, for each cause:
 *  - `invalid-credentials`: only a new sign-in mends it (refused, nothing to renew with, another church, a write the
 *    Keychain refused after Planning Center renewed).
 *  - `provider-failure`: Planning Center didn't renew it just now (no answer, a 429 or a 5xx); the next check tries again.
 *  - The Keychain, before Planning Center was asked: `locked` comes right by itself and the next check tries again;
 *    `denied` and `store-unavailable` leave the connection failed for the leader to act on (review N, 4).
 *  - Anything else (a sign-in or Disconnect under way, a cancel): not just now.
 */
function notRenewed(known: string, what: string, next: NotRenewedNext): string {
  const lead = "Ozzie's sign-in to Planning Center needed renewing";
  if (known.includes("invalid-credentials") || known.includes("missing-credentials")) return `${lead} and couldn't be renewed, ${what}. ${next.again}`;
  if (known.includes('"provider-failure"')) return `${lead}, and Planning Center didn't renew it just now, ${what}. ${next.reached}`;
  if (known.includes('"locked"')) return `${lead}, and this Mac's credential storage was locked, ${what}. ${next.locked}`;
  if (known.includes('"denied"')) return `${lead}, and this Mac didn't let Ozzie use it, ${what}. ${next.denied}`;
  if (known.includes('"store-unavailable"')) return `${lead}, and this Mac's credential storage couldn't be read, ${what}. ${next.unavailable}`;
  return `${lead} and couldn't be renewed just now, ${what}. ${next.later}`;
}

/** Why the Sunday picker couldn't list anything. Fixed local copy only; native error text is never rendered. */
export function choicesProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("sign-in-not-renewed")) {
    const later = "Try again in a moment, or enter the plan by hand.";
    return notRenewed(known, "so your services weren't listed", { again: "Connect again in Settings, or enter the plan by hand.",
      reached: later, locked: later, denied: "Allow access when macOS asks, then try again, or enter the plan by hand.", unavailable: later, later });
  }
  if (known.includes("not-connected") || known.includes("missing-credentials") || known.includes("invalid-credentials")) return "Connect Planning Center first. Then your upcoming services are listed here.";
  if (known.includes("rate-limited")) return "Planning Center asked Ozzie to slow down. Try again in a minute, or enter the plan by hand.";
  if (known.includes("busy")) return "Ozzie is reading Planning Center for something else right now. Try again in a moment.";
  if (known.includes("denied")) return PICKER_REFUSED;
  if (known.includes("organization")) return ORGANIZATION_UNCONFIRMED;
  return "Planning Center couldn't be read just now. Try again, or enter the plan by hand.";
}

/**
 * Planning Center refused a read (native "denied": its 401 or 403, which native code doesn't tell apart). Ozzie always
 * asks for Services at sign-in, so what is left is one of two causes it can't tell apart from here: the login signed in
 * with can't see that service type, or that sign-in is no longer accepted (audit item 5). Said as "one of these", with
 * who can give access and the next step.
 */
export const REFUSED = {
  summary: "Planning Center didn't let Ozzie read this service's plan.",
  either: "It's one of these, and Ozzie can't tell which from here:",
  login: "The Planning Center account you signed in with can't see this service's plans. A Planning Center administrator at your church can give that account access to it in Planning Center Services.",
  signIn: "That sign-in is no longer accepted. Connecting again fixes this.",
  next: "Then connect again, or choose a service this account can see.",
  signInButton: "Open Settings to connect again",
  chooseButton: "Open Settings to choose another service",
} as const;
/**
 * "Copy a message for your administrator", beside each refusal above that says an administrator can give access
 * (walk-through, 2026-11-18): what Ozzie is, that it only reads, the permission it needs and where it's changed, with no
 * name, church, service or number in it. The permission and the way to it are Planning Center's own (its help page
 * "Permissions in Services", read 2026-11-18): Viewer is the lowest level that sees plans the person isn't scheduled
 * on, and an administrator sets it in Services under People, the person, Actions, Manage permissions, then Update.
 */
export const ADMIN_COPY = "Copy a message for your administrator";
export const ADMIN_COPIED = "Copied. Paste it into an email or a message to your Planning Center administrator.";
export const adminMessage = () => "Hi! I'd like to use Ozzie, an app on my Mac that reads our church's Planning Center Services to show me who's scheduled "
  + `and what still needs people. ${promise("request")} Planning Center doesn't let my account see our service plans yet. Could you give my account the `
  + "Viewer permission in Services? In Services, open People, choose my name, then Actions, then Manage permissions. Set People and Plans to Viewer, "
  + "then choose Update. Thank you!";
export const PICKER_REFUSED = "Planning Center didn't let Ozzie list your church's plans. Either the account you signed in with can't see Planning Center Services, or that sign-in is no longer accepted. A Planning Center administrator at your church can give your account access to Services; then connect again. You can also enter a plan by hand.";
/** A refused check in one line (the service page's other form, and Keeping watch), with its copy button. */
export const CHECK_REFUSED = `${REFUSED.summary} Either the account you signed in with can't see this service's plans, or that sign-in is no longer accepted. A Planning Center administrator at your church can give your account access; then connect again under Settings, or choose another service.`;
/** A connected church Planning Center couldn't confirm (organization diagnostics), said by what it is, never an id. */
export const ORGANIZATION_UNCONFIRMED = "Ozzie couldn't confirm which church this Planning Center sign-in is for, so nothing was read.";
/** Whether a failed check was a refused read (REFUSED), so the Sunday page can offer its next steps. */
export const refusedRead = (error: unknown): boolean => {
  const known = JSON.stringify(error) ?? "";
  return known.includes("denied") && !known.includes("not-connected") && !known.includes("missing-credentials") && !known.includes("invalid-credentials")
    && !known.includes("sign-in-not-renewed");
};

/** Fixed local copy only. Native error text is never rendered. */
export function sundayProblem(error: unknown): string {
  const known = JSON.stringify(error) ?? "";
  if (known.includes("sign-in-not-renewed")) {
    return notRenewed(known, "so nothing was read", { again: "Connect again in Settings.", reached: "Ozzie tries again at the next check.",
      locked: "Ozzie tries again at the next check.", denied: "Allow access when macOS asks, then check again.",
      unavailable: "Check again in a moment; if it keeps happening, connect again in Settings.", later: "Try again in a moment, or connect again in Settings." });
  }
  // Checking the saved sign-in before the check found none Ozzie can use (refused, or nothing to renew with).
  if (known.includes('"invalid-token"')) return "Ozzie has no sign-in to Planning Center it can use, so nothing was read. Connect again in Settings.";
  if (known.includes("not-connected") || known.includes("missing-credentials") || known.includes("invalid-credentials")) return `Connect Planning Center first. ${promise("connectAnd")}`;
  if (known.includes("rate-limited")) return "Planning Center asked Ozzie to slow down. Wait a minute, then check again, or show the last saved check.";
  if (known.includes("denied")) return CHECK_REFUSED;
  if (known.includes("organization")) return ORGANIZATION_UNCONFIRMED;
  return "Planning Center couldn't be checked just now. You can show the last saved check instead.";
}
