// Church rules for the church reads, as the leader sets them on Church rules. Pure. Only ids are
// kept: form, Check-Ins event, Check-Ins room and Services team ids. Names stay in the capture's
// local labels and are never stored here.
import type { SundayRules } from "../sunday-capture.js";
import { isId } from "./common.js";

/** The native check reads submissions for at most this many forms (sunday_check.rs MAX_FORMS). */
export const MAX_WATCHED_FORMS = 10;
/** Room matches kept: one per Check-Ins room. */
export const MAX_ROOM_MATCHES = 40;

/** Whether the leader turned People forms on. Off (the default): no form is read at all. */
export const formsOn = (rules: SundayRules) => rules.forms?.on === true;
/** The forms the leader chose to watch: valid, distinct ids, in the order chosen, at most MAX_WATCHED_FORMS. */
export function watchedForms(rules: SundayRules): string[] {
  const watched = Array.isArray(rules.forms?.watched) ? rules.forms.watched as unknown[] : [];
  return [...new Set(watched.filter(isId))].slice(0, MAX_WATCHED_FORMS);
}
/** What the Sunday check is given: null while forms are off (nothing read), else the watched ids (the list only when none). */
export const formIdsForCheck = (rules: SundayRules): string[] | null => formsOn(rules) ? watchedForms(rules) : null;
export const withFormsOn = (rules: SundayRules, on: boolean): SundayRules => ({ ...rules, forms: { on, watched: watchedForms(rules) } });
/** Watches a form, or stops watching it. An eleventh form isn't added. */
export function withWatchedForm(rules: SundayRules, form_id: string, watch: boolean): SundayRules {
  const now = watchedForms(rules).filter(id => id !== form_id);
  const watched = watch && isId(form_id) && now.length < MAX_WATCHED_FORMS ? [...now, form_id] : now;
  if (watch && !watched.includes(form_id)) return rules;
  return { ...rules, forms: { on: formsOn(rules), watched } };
}

/** The Check-Ins event last Sunday is read from, when the leader chose one; null means every event. */
export const checkInsEvent = (rules: SundayRules): string | null => isId(rules.checkIns?.event_id) ? rules.checkIns.event_id : null;
export function withCheckInsEvent(rules: SundayRules, event_id: string | null): SundayRules {
  const rest = { ...rules.checkIns };
  delete rest.event_id;
  return { ...rules, checkIns: event_id && isId(event_id) ? { ...rest, event_id } : rest };
}
/** Check-Ins rooms the leader matched to a kids team: one team per room, valid ids only. */
export function roomMatches(rules: SundayRules): { location_id: string; team_id: string }[] {
  const seen = new Set<string>();
  return (Array.isArray(rules.checkIns?.rooms) ? rules.checkIns.rooms as unknown[] : []).flatMap(r => {
    if (!r || typeof r !== "object") return [];
    const { location_id, team_id } = r as Record<string, unknown>;
    if (!isId(location_id) || !isId(team_id) || seen.has(location_id)) return [];
    seen.add(location_id);
    return [{ location_id, team_id }];
  }).slice(0, MAX_ROOM_MATCHES);
}
/** Matches a Check-Ins room to a kids team, or (null) takes the match away. */
export function withRoomMatch(rules: SundayRules, location_id: string, team_id: string | null): SundayRules {
  const rest = roomMatches(rules).filter(m => m.location_id !== location_id);
  const rooms = team_id && isId(team_id) && isId(location_id) && rest.length < MAX_ROOM_MATCHES ? [...rest, { location_id, team_id }] : rest;
  return { ...rules, checkIns: { ...rules.checkIns, rooms } };
}
