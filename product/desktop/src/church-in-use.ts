// What belongs to one church on this Mac, and the church Ozzie uses now (review S, M1). After a switch, nothing read
// from the old church is shown or used under the new one: its check is hidden, and the Church rules set for its teams,
// rooms and findings are kept aside for it rather than applied to another church's teams.
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";

/**
 * The check on screen, if it may be shown: the fictional example, or a check of the church in Settings while that is
 * also the church Ozzie uses natively (when native code says which). Anything else belongs to another church.
 */
export function onScreenCapture(capture: SundayCapture | null, fictional: boolean, organization: string, inUse: string | undefined): SundayCapture | null {
  if (!capture) return null;
  if (fictional) return capture;
  if (capture.organization !== organization) return null;
  return inUse !== undefined && inUse !== capture.organization ? null : capture;
}
/**
 * The same rule for a live check that finishes, or is reused, after the moment it was asked for: whether it is of the
 * church Ozzie uses now. A check of another church is dropped by every consumer (Sunday, the runner, Ask's refresh).
 */
export const ofChurchInUse = (capture: SundayCapture, organization: string, inUse: string | undefined) =>
  onScreenCapture(capture, false, organization, inUse) !== null;

/**
 * The Church rules that name one church's teams, rooms, forms, Check-Ins rooms and findings. The rest (Sundays in a
 * row) apply to any church.
 */
const CHURCH_KEYS = ["sundayLeads", "rooms", "kidsTeams", "kidsBackgroundChecks", "feedback", "forms", "checkIns"] as const;
export type ChurchRules = Partial<Pick<SundayRules, (typeof CHURCH_KEYS)[number]>>;
/** Which church the Church rules in use were set for, and the church-specific ones kept for other churches. */
export interface RulesByChurch { church: string; kept: Record<string, { rules: ChurchRules; name?: string }> }
export const NO_CHURCH: RulesByChurch = { church: "", kept: {} };

export function churchRules(rules: SundayRules): ChurchRules {
  const out: Record<string, unknown> = {};
  for (const key of CHURCH_KEYS) if (rules[key] !== undefined) out[key] = rules[key];
  return out as ChurchRules;
}
/** Whether any rule is set for this church's teams, rooms or findings, including turning the background-check rule off. */
export function hasChurchRules(rules: SundayRules): boolean {
  return rules.sundayLeads.length > 0 || (rules.rooms?.length ?? 0) > 0 || (rules.kidsTeams?.length ?? 0) > 0 || (rules.feedback?.length ?? 0) > 0
    || rules.kidsBackgroundChecks === false || rules.forms?.on === true || (rules.forms?.watched?.length ?? 0) > 0
    || rules.checkIns?.event_id !== undefined || (rules.checkIns?.rooms?.length ?? 0) > 0;
}
const numeric = (value: string | undefined): value is string => value !== undefined && /^[1-9]\d{0,31}$/.test(value);
/**
 * Church rules saved before rules were kept per church belong to the church in Settings, where they were set, not to
 * whichever church Ozzie happens to use first (review S2, M3). Unchanged when the church is already recorded.
 */
export function adoptRules(store: RulesByChurch, settingsOrganization: string): RulesByChurch {
  return store.church || !numeric(settingsOrganization) ? store : { church: settingsOrganization, kept: store.kept };
}
/** The rules with nothing church-specific: what applies to a church nothing was set for yet. */
export function withoutChurchRules(rules: SundayRules): SundayRules {
  const out: Record<string, unknown> = { ...rules };
  for (const key of CHURCH_KEYS) delete out[key];
  return { ...(out as Omit<SundayRules, "sundayLeads">), sundayLeads: [] };
}
/**
 * When the church Ozzie uses natively becomes `to`: the church-specific rules in use are kept for the church they were
 * set for, and any kept for `to` come back. The first church seen adopts the rules as they are. Null when nothing moves.
 */
export function moveRules(rules: SundayRules, store: RulesByChurch, to: string, fromName?: string, settingsOrganization = ""): { rules: SundayRules; store: RulesByChurch } | null {
  if (!numeric(to)) return null;
  // Rules not yet recorded for a church belong to the church in Settings, where they were set (review S2, M3).
  const owned = adoptRules(store, settingsOrganization);
  if (owned.church === to) return owned === store ? null : { rules, store: owned };
  if (!owned.church) return { rules, store: { church: to, kept: owned.kept } };
  const kept = { ...owned.kept };
  if (hasChurchRules(rules)) kept[owned.church] = { rules: churchRules(rules), ...(fromName ? { name: fromName } : {}) };
  else delete kept[owned.church];
  const back = kept[to]?.rules ?? {};
  delete kept[to];
  const base = withoutChurchRules(rules);
  return { rules: { ...base, ...back, sundayLeads: Array.isArray(back.sundayLeads) ? back.sundayLeads : [] }, store: { church: to, kept } };
}
/**
 * The rules checks and answers use: as set, unless they were set for another church than the one Ozzie uses now (the
 * moment before `moveRules` runs), when nothing church-specific applies.
 */
export function rulesInUse(rules: SundayRules, store: RulesByChurch, inUse: string | undefined, settingsOrganization = ""): SundayRules {
  const owner = adoptRules(store, settingsOrganization).church;
  return inUse !== undefined && owner !== "" && owner !== inUse ? withoutChurchRules(rules) : rules;
}

/**
 * What a switch from `question.from` to `question.to` does to Church rules: whether rules are set for the church in use's
 * teams, rooms or findings (they stay with it), and whether rules were kept for the other church (they come back).
 */
export function rulesAtStake(question: { from: string; to: string }, rules: SundayRules, store: RulesByChurch): { from: boolean; to: boolean } {
  return {
    from: (store.church === "" || store.church === question.from) && hasChurchRules(rules),
    to: Object.hasOwn(store.kept, question.to),
  };
}

const KEY = "ozzie.rules-by-church.v1";
/** Kept on this Mac only, apart from the Church rules (which the AI's facts are built from). */
export function loadRulesByChurch(): RulesByChurch {
  try {
    const raw: unknown = typeof localStorage === "undefined" ? null : JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return NO_CHURCH;
    const { church, kept } = raw as Record<string, unknown>;
    if (typeof church !== "string" || kept === null || typeof kept !== "object" || Array.isArray(kept)) return NO_CHURCH;
    const valid: RulesByChurch["kept"] = {};
    for (const [organization, entry] of Object.entries(kept as Record<string, unknown>)) {
      if (!/^[1-9]\d{0,31}$/.test(organization) || entry === null || typeof entry !== "object") continue;
      const { rules, name } = entry as Record<string, unknown>;
      if (rules === null || typeof rules !== "object" || Array.isArray(rules)) continue;
      valid[organization] = { rules: rules as ChurchRules, ...(typeof name === "string" && name.length <= 120 ? { name } : {}) };
    }
    // A church that isn't an organization number is no church: rules filed under it would be dropped on the next load
    // (review S3, L4). The rules in use then belong to the church in Settings (`adoptRules`).
    return { church: numeric(church) ? church : "", kept: valid };
  } catch {
    return NO_CHURCH;
  }
}
export function saveRulesByChurch(store: RulesByChurch) {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* per-device convenience only */ }
}
