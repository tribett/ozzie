// Changes in Planning Center, one at a time, each confirmed by the leader on screen (the write-back design,
// owner decisions 2026-11-17). The one change: from an open role's "who could help" list, add one person to that role
// as unconfirmed, with Planning Center's request waiting (not sent). Off by default for each church.
//
// This is the only page module that names the change commands. Native code (src-tauri changes.rs, core/native-auth
// change.rs) reads Planning Center again before it answers, builds the exact change from the church's last live check,
// keeps it in memory for five minutes and makes it only on `change_confirm`. The page holds the change's id and ids
// from the check on screen; never a name, never free text. Nothing here reaches a model, a notice, Siri, the copy for
// other AI apps or a scheduled job: the stays-on-this-Mac proofs (product/desktop/test/planning-center-changes.test.ts)
// hold it to the page modules.
//
// Every sentence a person sees about a change is here, each true for its own cause. "Nothing changed" is said for every
// refusal (native refuses before anything is sent) and never for an answer that isn't known.
import { invoke } from "@tauri-apps/api/core";

/** The background check Planning Center records for the person, read just now (a kids team only). */
export type BackgroundCheck = "current" | "none-on-file" | "pending" | "expired" | "expires-by-that-sunday" | "could-not-read";
/** Why native code didn't make (or undo) a change. Nothing was sent to Planning Center for any of these. */
export type Refusal =
  | "off" | "no-live-check" | "not-in-this-check" | "not-listed-to-help" | "role-not-open" | "split-team" | "child" | "inactive" | "status-unknown" | "no-people-access"
  | "already-on-plan" | "no-longer-in-that-position" | "blocked-out" | "repeating-blockout" | "other-plan-then" | "plan-passed"
  | "changed-since-you-looked" | "check-again" | "expired" | "unknown-change" | "advice-not-acknowledged" | "nothing-to-acknowledge"
  | "busy-with-a-check" | "busy-with-another-change" | "too-many-just-now" | "too-many-today" | "not-connected" | "church-changed"
  | "not-allowed" | "could-not-check" | "deadline-passed" | "not-ozzies-change" | "request-already-sent" | "person-answered" | "other-system";
export const REFUSALS: readonly Refusal[] = Object.freeze([
  "off", "no-live-check", "not-in-this-check", "not-listed-to-help", "role-not-open", "split-team", "child", "inactive", "status-unknown", "no-people-access",
  "already-on-plan", "no-longer-in-that-position", "blocked-out", "repeating-blockout", "other-plan-then", "plan-passed",
  "changed-since-you-looked", "check-again", "expired", "unknown-change", "advice-not-acknowledged", "nothing-to-acknowledge",
  "busy-with-a-check", "busy-with-another-change", "too-many-just-now", "too-many-today", "not-connected", "church-changed",
  "not-allowed", "could-not-check", "deadline-passed", "not-ozzies-change", "request-already-sent", "person-answered", "other-system",
]);
export const BACKGROUND_CHECKS: readonly BackgroundCheck[] = Object.freeze(["current", "none-on-file", "pending", "expired", "expires-by-that-sunday", "could-not-read"]);

/** The switch for the church in use (`on` is false while Planning Center isn't connected). */
export interface ChangesStatus { organization: string | null; on: boolean }
/** One change native code has ready, after reading Planning Center again: what the confirmation shows. */
export interface Proposed {
  /** The change's id (32 hex), used once by `confirm`. */
  change: string;
  plan: string; team: string; person: string;
  /** Planning Center's own name for the position. */
  position: string;
  /** The plan's day, church-local ("2026-11-29"; the field keeps native code's name whatever the weekday). */
  sunday: string;
  times: { starts_at: string; ends_at: string }[];
  /** Open places for this role now, before the change. */
  still_needed: number;
  kids_team: boolean;
  background_check?: BackgroundCheck;
  /** The date the check on file ends or ended ("2026-10-01"), when Planning Center records one (a kids team only). */
  background_check_date?: string;
  /** True for a kids team with any background-check fact but "current". */
  advised_against: boolean;
  checked_at: string;
  /** Five minutes after `checked_at`: native code won't use the change after this. */
  expires_at: string;
}
/** What happened's record of one change: ids, with the role and the plan's day (neither names a person). */
export interface ChangeRecord {
  action: "added-unconfirmed" | "took-off";
  organization: string; service_type: string; plan: string; team: string; person: string;
  /** Planning Center's own name for the position, as the check read it ("Greeter"). */
  role: string;
  /** The plan's day, church-local ("2026-11-29"). */
  sunday: string;
  row?: string; prepared_at?: string; confirmed_at: string; sent_at: string; status?: number;
  came_back: "made" | "made-after-all" | "refused" | "nothing-changed" | "unknown" | "several-rows" | "removed" | "already-gone";
  read_back?: "as-expected" | "not-seen";
  confirmed_by?: string;
  confirmation: "on-screen";
  despite_advice?: BackgroundCheck;
}
export type Outcome =
  | { result: "made"; record: ChangeRecord }
  | { result: "made-after-all"; record: ChangeRecord }
  | { result: "not-made"; reason: Refusal }
  | { result: "refused-by-planning-center"; status: number; not_allowed: boolean }
  | { result: "nothing-changed" }
  /** No clear answer, then reading the plan again found the person on it more than once. */
  | { result: "several-rows" }
  | { result: "unknown" };
export type Undone =
  | { result: "removed" }
  | { result: "already-gone" }
  | { result: "not-removed"; reason: Refusal }
  | { result: "refused-by-planning-center"; status: number; not_allowed: boolean }
  | { result: "unknown" };

/** A refusal native code rejected with, or null for anything else (a failed call, a value from no known cause). */
export const refusalOf = (error: unknown): Refusal | null => typeof error === "string" && (REFUSALS as readonly string[]).includes(error) ? error as Refusal : null;

// ---- The calls (the only place these commands are named) -------------------------------------------------------

export const changes = Object.freeze({
  /** The switch for the church in use. */
  status: (): Promise<ChangesStatus> => invoke<ChangesStatus>("changes_status"),
  /** Turns the switch on or off for the church in use; rejects "not-connected" or "unavailable". */
  set: (on: boolean): Promise<ChangesStatus> => invoke<ChangesStatus>("changes_set", { on }),
  /**
   * Asks native code to get one change ready: `plan` the plan of the check on screen (native refuses another), `team` and `position` as the open role's finding names them, `person` the
   * Planning Center id on the row the leader chose, `kidsTeamIds` the church's marked kids teams. Rejects with a Refusal.
   */
  prepare: (p: { plan: string; team: string; position: string; person: string; kidsTeamIds: readonly string[] }): Promise<Proposed> =>
    invoke<Proposed>("change_prepare", { plan: p.plan, team: p.team, position: p.position, person: p.person, kidsTeamIds: [...p.kidsTeamIds] }),
  /** The leader's yes to that one change. `despiteAdvice` only when advised against and the leader chose to go ahead. */
  confirm: (change: string, despiteAdvice?: BackgroundCheck): Promise<Outcome> =>
    invoke<Outcome>("change_confirm", despiteAdvice ? { change, despiteAdvice } : { change }),
  /** Takes off a person this session added, by the row Planning Center made. */
  undo: (row: string): Promise<Undone> => invoke<Undone>("change_undo", { row }),
  /** This church's records, newest first. */
  history: (limit = 50): Promise<ChangeRecord[]> => invoke<ChangeRecord[]>("change_history", { limit }),
});

// ---- Words -------------------------------------------------------------------------------------------------------

/**
 * Who and what a sentence is about: the person's first name as shown, the role (Planning Center's name for it), and, once
 * known, the plan in words (`planWords`: "the Youth Night plan for Wednesday, Nov 25").
 */
export interface Said { name: string; role: string; at?: string | null; plan?: string | null }
/**
 * Which plan a change is on, in words: the service's own name (several services watched, owner decision 2026-11-19) and its
 * day, never "Sunday" for a service on another day. "the Weekend Service plan for Sunday, Nov 29"; without the name "the
 * plan for Sunday, Nov 29"; with neither "the plan".
 */
export function planWords(service: string | null | undefined, day: string | null | undefined): string {
  const name = service?.trim() ? `the ${service.trim()} plan` : "the plan";
  return day ? `${name} for ${day}` : name;
}
const planOf = (said: Said) => said.plan ?? "the plan";
/** A first name from the name shown, or "this person" when Ozzie can't name them. */
export const firstName = (full: string | null | undefined): string => full?.trim().split(/\s+/u)[0] || "this person";
/** "Riley", "Riley and Sam", "Riley, Sam and Drew". */
export const namesList = (names: readonly string[]): string => names.length < 2 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The button on a person's row in "who could help". */
export const addButton = (name: string, role: string) => `Add ${name} to ${role} in Planning Center…`;
export const CHECKING = "Checking Planning Center…";
/** The leader's yes, naming the person; "anyway" when Ozzie advised against it. */
export const yesAdd = (name: string, advised: boolean) => `Add ${name}${advised ? " anyway" : ""} — I'll send the request in Planning Center`;
export const dontAdd = (name: string) => `Don't add ${name}`;
export const takeOff = (name: string) => `Take ${name} off again`;
/** Said beside the yes while it can't be used yet. */
export const selectFirst = (name: string) => `Select the box above to add ${name} anyway.`;
export const LOOK_AGAIN = (name: string) => `Look again before adding ${name}`;
export const CLOSE = "Close";
export const HIDE = "Hide this";
export const adding = (name: string) => `Adding ${name} in Planning Center…`;
export const takingOff = (name: string) => `Taking ${name} off in Planning Center…`;
/** On the role's card after a change or an undo, until the new check is in (native code dropped the old one). */
export const RECHECKING = "Checking Planning Center again…";
export const RECHECK_FAILED = "Ozzie couldn't read Planning Center again just now, so this list may be out of date. Press “Check Planning Center now” before adding anyone.";

/** The confirmation's title, with the full name shown, the service and its day ("Sunday, Nov 29", as Planning Center dates the plan). */
export const confirmTitle = (full: string, service: string | null, day: string) => `Add ${full} to ${planWords(service, day)}?`;
// The confirmation in short (polish 2026-11-21, item 4): what Planning Center will do and what Ozzie does, the open place,
// what was checked and that undo works until the request is sent, in view; how undo ends and the five minutes, in its fold.
/** What Planning Center will do, and what Ozzie does: whether its automatic reminders reach the person isn't known. */
export const confirmWaiting = (name: string) =>
  `Planning Center will list ${name} as unconfirmed, with the request not sent. Ozzie sends ${name} nothing; you press Send there.`;
/** That adding them uses up the open place before anyone is asked. */
export function confirmPlace(name: string, role: string, stillNeeded: number): string {
  if (stillNeeded < 1) return "";
  return `${stillNeeded === 1 ? `Adding ${name} fills the one open place for ${role}` : `Adding ${name} fills one of the ${stillNeeded} open places for ${role}`}, even before ${name} is asked.`;
}
/** Under the fold: taking them off gives the place back. */
export const confirmPlaceBack = (name: string) => `Taking ${name} off again gives the place back.`;
export const confirmChecked = (at: string, name: string) =>
  `Checked at ${at}: the role is still open; ${name} isn't on this plan, has no blockout or other plan then, is listed as active, and isn't listed as a child in Planning Center.`;
/**
 * How long undo lasts: native code keeps the proof that it made the row in memory only, and forgets it on quit, a church
 * switch, Disconnect and turning changes off. The first line is in view; what ends it is under the fold.
 */
export const confirmUndo = (name: string) => `Until you send the request, you can take ${name} off again here while Ozzie stays open.`;
export const confirmUndoEnds = (name: string) =>
  `You can't take ${name} off here after you quit Ozzie, switch churches, disconnect or turn off “Adding people in Planning Center” in Settings; then take ${name} off in Planning Center.`;
export const confirmUntil = (at: string, name: string) => `If you wait past ${at}, Ozzie will need to look at Planning Center again before adding ${name}.`;
export const CONFIRM_EXPIRED = "This confirmation waited more than 5 minutes, so Ozzie won't use it. Nothing changed.";

/** The background-check fact, as Planning Center's record shows it (never about the person), with when it was read. `day`: the service's day. */
export function backgroundFact(check: BackgroundCheck, name: string, day: string, readAt: string, date: string | null = null): string {
  const at = ` (read at ${readAt})`;
  switch (check) {
    case "current": return `Planning Center shows a current background check on file for ${name}${at}.`;
    case "none-on-file": return `Planning Center shows no current background check on file for ${name}${at}.`;
    case "pending": return `Planning Center shows a background check for ${name} that isn't finished yet${at}.`;
    case "expired": return date ? `Planning Center shows ${name}'s background check on file ended on ${dayLabel(date)}${at}.`
      : `Planning Center shows ${name}'s background check on file is no longer current${at}.`;
    // Today is taken as the earliest date anywhere, so the end date may already have passed here: said as a date, not a future.
    case "expires-by-that-sunday": return date ? `Planning Center shows ${name}'s background check on file has an end date of ${dayLabel(date)}, on or before ${day}${at}.`
      : `Planning Center shows ${name}'s background check on file ends on or before ${day}${at}.`;
    case "could-not-read": return `Ozzie couldn't read ${name}'s background check in Planning Center just now, so it can't tell whether there is a current one.`;
  }
}
/** The warning panel's first line, then why: the church's own mark. */
export const KIDS_NOT_ADVISED = "Not advised: this is a kids team.";
export const KIDS_MARKED = "This team is marked as a kids team in your Church rules.";
/** The advice under the fact. */
export const kidsAdvice = (check: BackgroundCheck): string => check === "could-not-read"
  ? "Look in Planning Center first. Ozzie advises adding someone to a kids team only when you've seen a current background check."
  : "Ozzie advises adding someone to a kids team only when Planning Center shows a current background check.";
export const despiteChoice = (name: string) => `I've read this advice, and I still want to add ${name} to this kids team.`;
export const despiteHelp = (name: string) => `Ozzie won't stop you; this is your choice. If you go ahead, What happened notes that you added ${name} despite this advice.`;

/** Why nothing was made or undone, true for each cause. */
export function refusalSentence(r: Refusal, { name, role, at }: Said): string {
  const roleAt = at ? `${role} role at ${at}` : `${role} role`;
  switch (r) {
    case "off": return "Nothing changed. Adding people in Planning Center is turned off for this church. You can turn it on in Settings.";
    case "no-live-check": return "Nothing changed. Ozzie needs a new check of Planning Center first. Check Planning Center now, then try again.";
    case "not-in-this-check": return `Nothing changed. The check on screen no longer has the ${roleAt}. Check Planning Center now, then try again.`;
    case "not-listed-to-help": return `Nothing changed. Ozzie's check doesn't list ${name} as someone who could help with ${role}.`;
    case "role-not-open": return `Nothing changed. The ${roleAt} is no longer open in Planning Center.`;
    case "split-team": return `Nothing changed. This team is scheduled by service time in Planning Center, and Ozzie can't add people to a team like that. You can add ${name} in Planning Center.`;
    case "child": return `Nothing changed. Planning Center lists ${name} as a child, and Ozzie never adds a child to a team.`;
    case "inactive": return `Nothing changed. Planning Center lists ${name} as inactive, so Ozzie doesn't add them. You can change that in Planning Center.`;
    // The record was read, but its status was missing, empty or not one Ozzie knows.
    case "status-unknown": return `Nothing changed. Ozzie couldn't tell from Planning Center's record whether ${name} is active, so it doesn't add them. You can check their record in Planning Center.`;
    case "no-people-access": return `Nothing changed. Your sign-in doesn't include Planning Center People, so Ozzie can't confirm ${name} isn't listed as a child. You can add People access in Settings, under “Rooms, follow-ups and group events”.`;
    case "already-on-plan": return `Nothing changed. ${name} is already on this plan in Planning Center.`;
    case "no-longer-in-that-position": return `Nothing changed. Planning Center no longer lists ${name} in the ${role} position on this team.`;
    case "blocked-out": return `Nothing changed. ${name} has a blockout for that day in Planning Center.`;
    case "repeating-blockout": return `Nothing changed. ${name} has a repeating blockout in Planning Center, and Ozzie can't tell whether it covers that day. You can look in Planning Center.`;
    case "other-plan-then": return `Nothing changed. ${name} is on another plan in Planning Center at that time.`;
    case "plan-passed": return "Nothing changed. This plan's date has passed.";
    case "changed-since-you-looked": return "Nothing changed. Planning Center reads differently now than when Ozzie showed you this change. Check Planning Center now, then try again.";
    case "check-again": return "Nothing changed. Planning Center has changed since the last check. Check Planning Center now, then try again.";
    case "expired": return CONFIRM_EXPIRED;
    case "unknown-change": return "Nothing changed. Ozzie no longer has this change ready. Look again to see it with what Planning Center shows now.";
    case "advice-not-acknowledged": return `Nothing changed. To add ${name} despite the advice, select the box that says you still want to.`;
    case "nothing-to-acknowledge": return "Nothing changed. Planning Center's record no longer matches the advice shown. Look again to see it with what Planning Center shows now.";
    case "busy-with-a-check": return "Nothing changed. Ozzie is checking Planning Center right now. Try again when the check finishes.";
    case "busy-with-another-change": return "Nothing changed. Ozzie is making another change right now. Try again in a moment.";
    case "too-many-just-now": return "Nothing changed. That's as many changes as Ozzie makes in one minute. Wait a minute, then try again.";
    case "too-many-today": return "Nothing changed. That's as many changes as Ozzie makes for this church in a day. You can still make this change in Planning Center.";
    // Also while a sign-in renewal runs or after one failed (the switch and undo stay): a moment later may work.
    case "not-connected": return "Nothing changed. Planning Center isn't connected just now. Try again in a moment; if it still isn't, connect it in Settings.";
    case "church-changed": return "Nothing changed. Ozzie is using another church now, so this change was dropped.";
    // A read refused (401 or 403) while Ozzie checked again: nothing was sent.
    case "not-allowed": return "Nothing changed. Planning Center didn't let Ozzie read what it checks before a change, so nothing was sent. You can make this change in Planning Center instead.";
    case "could-not-check": return "Nothing changed. Ozzie couldn't read Planning Center again just now. Try again in a moment.";
    case "deadline-passed": return "Nothing changed. Planning Center didn't answer in time, so Ozzie didn't send the change.";
    // Native code keeps the rows it made in memory only, and forgets them on quit, a church switch, Disconnect and turning off.
    case "not-ozzies-change": return `Nothing changed. Ozzie can take someone off only if it added them since Ozzie was last opened, and before any church switch, disconnect or turning off “Adding people in Planning Center”. You can take ${name} off in Planning Center.`;
    case "request-already-sent": return `Nothing changed. ${name} has been sent a request, and Ozzie can't take that back. You can change it in Planning Center.`;
    case "person-answered": return `Nothing changed. ${name} has already answered the request in Planning Center. You can change it there.`;
    // Native code's own check (changes.rs): a key for B1 Church or Breeze is saved on this Mac, so it only reads.
    case "other-system": return "Nothing changed. This Mac keeps a key for B1 Church or Breeze, and Ozzie only reads while it does: it doesn't change Planning Center from here.";
  }
}
/** Planning Center refused the write itself (401 or 403): the account can't schedule there. */
export const WRITE_NOT_ALLOWED = "Nothing changed. Planning Center says your account can't schedule people on this team.";
/** A call that failed some other way: getting a change ready writes nothing, so nothing changed. */
export const PREPARE_FAILED = "Nothing changed. Ozzie couldn't get this change ready just now. Try again in a moment.";
/** What to do when whether the person was added isn't known (no Take-off button then). */
const lookForThem = (name: string) =>
  `Open the plan in Planning Center to see whether ${name} is on it before trying again. If ${name} is there and shouldn't be, take them off there.`;
/** A yes whose answer never came back to the page: whether it was made isn't known. */
export const notKnown = (name: string) => `Ozzie couldn't tell whether Planning Center added ${name}. ${lookForThem(name)}`;
/** "Take … off again" whose answer never came back to the page. */
export const undoNotKnown = (name: string) => `Ozzie couldn't tell whether Planning Center took ${name} off. Open the plan in Planning Center to see.`;

/**
 * The person is on the plan. That they haven't been asked is known only when Ozzie read the row back and Planning Center
 * showed the request still waiting (`read_back` "as-expected"); otherwise it says what is known. Both end at Send.
 */
function onPlan(record: ChangeRecord, said: Said): string {
  const { name, role } = said;
  return record.read_back === "as-expected"
    ? `${name} is on ${planOf(said)} as ${role}, unconfirmed. Ozzie sent ${name} nothing, and ${name} hasn't been asked yet: open the plan in Planning Center and press Send when you're ready.`
    : `${name} is on ${planOf(said)} as ${role}, unconfirmed. Ozzie sent ${name} nothing. Open the plan in Planning Center to check, and press Send when you're ready.`;
}
/** What came back from the leader's yes. */
export function outcomeSentence(o: Outcome, said: Said): string {
  switch (o.result) {
    case "made": return onPlan(o.record, said);
    // Each of these follows no answer, a 5xx, or a 2xx without the row's id: Planning Center didn't answer clearly.
    case "made-after-all": return `Planning Center didn't answer clearly, so Ozzie looked again. ${onPlan(o.record, said)}`;
    case "not-made": return refusalSentence(o.reason, said);
    case "refused-by-planning-center": return o.not_allowed ? WRITE_NOT_ALLOWED
      : "Nothing changed. Planning Center didn't accept the change. You can open the plan and make it there.";
    case "nothing-changed": return `Planning Center didn't answer clearly. Ozzie looked again: ${said.name} isn't on the plan, so nothing changed.`;
    case "several-rows": return `Planning Center didn't answer clearly, and Ozzie now sees ${said.name} on the plan more than once. Open the plan in Planning Center to check.`;
    case "unknown": return `Planning Center's answer didn't make clear whether the change was made. ${notKnown(said.name)}`;
  }
}
/** Whether a confirm's answer means a write went out (native then drops the check, so the page takes a fresh one). */
export const wroteOut = (o: Outcome): boolean => o.result !== "not-made";
export const made = (o: Outcome): o is Extract<Outcome, { record: ChangeRecord }> => o.result === "made" || o.result === "made-after-all";

/** What came back from "Take … off again" (possible only while the request is unsent, so it never went). */
export function undoSentence(u: Undone, said: Said): string {
  const { name, role } = said;
  switch (u.result) {
    case "removed": return `${name} is off ${planOf(said)} again, and the ${role} place is open again. The request was never sent.`;
    case "already-gone": return `${name} was already off ${planOf(said)} in Planning Center, so there was nothing to take off.`;
    // Taking off has its own pace (no daily cap), so its minute limit is said as taking off.
    case "not-removed": return u.reason === "too-many-just-now" ? UNDO_TOO_MANY : refusalSentence(u.reason, said);
    // A refused DELETE changed nothing; it isn't a reading of the plan, so it says nothing of who is on it now.
    case "refused-by-planning-center": return u.not_allowed
      ? `Nothing changed. Planning Center says your account can't change people on this team, so ${name} wasn't taken off. You can change it in Planning Center.`
      : `Nothing changed. Planning Center didn't accept taking ${name} off. You can change it in Planning Center.`;
    case "unknown": return `Ozzie couldn't confirm whether ${name} is still on the plan. Open the plan to see.`;
  }
}
export const UNDO_TOO_MANY = "Nothing changed. That's as many people as Ozzie takes off in one minute. Wait a minute, then try again.";
/** A take-off's answer as the result card keeps it: what native code said, or that its answer never reached the page. */
export type UndoAnswer = Undone | { result: "not-known" };
/** The add, said in the past once anything later is known (the present-tense sentence may no longer hold). */
export const addedPast = (name: string, role: string, at: string | null) =>
  `You added ${name} to ${role} as unconfirmed${at ? ` at ${at}` : ""}.`;
/**
 * What the result card says once "Take … off again" has an answer: only what is true now, never the add's present-tense
 * sentence. Removed is one sentence; otherwise the add in the past, then the answer. `tone` is the card's badge.
 */
export function afterUndo(a: UndoAnswer, said: Said, addedAt: string | null, offAt: string): { lines: string[]; tone: "made" | "look" | "unchanged" } {
  const { name, role } = said;
  const past = addedPast(name, role, addedAt);
  switch (a.result) {
    case "removed": return { tone: "unchanged", lines: [`You added ${name} to ${role}${addedAt ? ` at ${addedAt}` : ""} and took ${name} off again at ${offAt}. The ${role} place is open again; the request was never sent.`] };
    case "already-gone": return { tone: "unchanged", lines: [past, `When Ozzie went to take ${name} off at ${offAt}, ${name} was already off ${planOf(said)} in Planning Center, so there was nothing to take off.`] };
    // Nothing was taken off: the add stands as far as Ozzie knows.
    case "not-removed": return { tone: "made", lines: [past, undoSentence(a, said)] };
    case "refused-by-planning-center": case "unknown": return { tone: "look", lines: [past, undoSentence(a, said)] };
    case "not-known": return { tone: "look", lines: [past, undoNotKnown(name)] };
  }
}
/** Refusals that pass: "Take … off again" stays offered after one. */
const PASSING: ReadonlySet<Refusal> = new Set(["busy-with-a-check", "busy-with-another-change", "too-many-just-now", "could-not-check", "deadline-passed", "no-live-check", "not-connected"]);
export const mayTryUndoAgain = (u: Undone): boolean => u.result === "not-removed" && PASSING.has(u.reason);
/** Whether an undo's answer means a write went out. */
export const undoWroteOut = (u: Undone): boolean => u.result !== "not-removed";

// ---- Settings ------------------------------------------------------------------------------------------------------

export const SWITCH_TITLE = "Adding people in Planning Center";
export const SWITCH_LABEL = "Let Ozzie add someone to an open role in Planning Center, one at a time, when you confirm each one";
/**
 * Settings' words for the switch (polish 2026-11-21: six paragraphs made scannable, nothing taken out). `lead` is the one
 * sentence above the switch; `confirm` to `reminders` are the facts listed under it, always in view; `undo`, `church` and
 * `people` are in its See how this works fold (People access is in view instead while the sign-in doesn't include it).
 */
export const switchBody = (church: string | null) => ({
  lead: "With this on, you can add someone from an open role's “who could help” list on the Services page to that role, on that service's plan in Planning Center.",
  confirm: "Each one needs your confirmation on screen first. Planning Center shows you as the person who scheduled them.",
  waiting: "Planning Center lists them as unconfirmed, with the request waiting. Ozzie sends them nothing. Planning Center sends its request only when you press Send there.",
  one: "One person at a time, and never anyone with a possible conflict, or anyone left out.",
  never: "Ozzie never adds or picks anyone on its own, on a schedule, or from an AI's answer.",
  kids: "For a team your church marked as a kids team, Ozzie first shows the person's background check as Planning Center records it, and advises against adding anyone without a current one.",
  // Native code reads background checks for an add only on a team marked in Church rules (kids-rules-section.tsx).
  kidsWhere: "That advice covers only teams marked as kids teams in Church rules, under “Kids teams” (each team's “serves with kids” box). A team that isn't marked there gets no background-check advice.",
  // Owner to settle with a test inbox (write-back-live-answers.md); kept word for word until then.
  reminders: "Ozzie hasn't confirmed whether Planning Center's automatic reminders, if your church uses them, reach someone added this way before the request is sent.",
  undo: "Until you send the request, you can take the person off again from the Services page while Ozzie stays open; quitting Ozzie, switching churches, disconnecting or turning this off ends that.",
  church: `This is for ${church ?? "the church Ozzie uses now"} only; another church has its own switch. It's off until you turn it on, and it turns off if you switch churches or disconnect. To turn it off, untick the box.`,
  people: "Ozzie also needs People access, to see whether Planning Center lists a person as a child or as inactive and, for kids teams, their background check. Turn it on under “Rooms, follow-ups and group events” below.",
});
export const NO_PEOPLE_YET = "Until then, Ozzie can't add anyone.";
/** Said in Settings while the switch is off: nothing is changed in Planning Center then. */
export const switchOff = (church: string | null) => `Adding people is off for ${church ?? "this church"}, so Ozzie only reads its Planning Center.`;
export const switchProblem = (error: unknown): string => error === "not-connected"
  ? "Planning Center isn't connected, so this can't be turned on. Connect it first."
  : error === "other-system" ? "This Mac keeps a key for B1 Church or Breeze, so Ozzie only reads and this can't be turned on."
    : "Ozzie couldn't change this just now. Try again.";

// ---- Lines that say Ozzie only reads, as they read while changes are on ------------------------------------------

export const SIDEBAR_ON = "Reads Planning Center; changes it only when you confirm. Names Ozzie reads stay on this Mac.";
export const SETTINGS_BANNER_ON = {
  strong: "Reads Planning Center; changes it only when you confirm.",
  rest: "Planning Center may grant broad access at sign-in. Ozzie adds someone to an open role only after you confirm it, and takes them off again only when you ask. It has no way to send messages. The connection stays on this Mac, in its Keychain.",
} as const;
export const ACTIVITY_LEDE_ON = "Ozzie reads from Planning Center and makes only the changes you confirm, one at a time; they're listed below. It has no way to send messages or mark anything.";
/** The quit question, while someone added this session can still be taken off (native code forgets that on quit). */
export const quitUndo = (names: readonly string[]) => `After you quit, Ozzie can't take ${namesList(names)} off again; you can in Planning Center.`;

// ---- What happened ------------------------------------------------------------------------------------------------

export const HISTORY_TITLE = "Changes you confirmed in Planning Center";
/** Who: the account signed in on this Mac (native records its Planning Center id, never shown); the scheduler only for an add. */
export const HISTORY_WHO = "Each change was confirmed on this Mac and sent under the Planning Center account signed in here. For someone added, Planning Center shows that account as the scheduler.";
export const HISTORY_NONE = "No changes yet. Each one you confirm is listed here.";
/** "Thursday, Oct 1" from a date ("2026-10-01"), read as that calendar day. */
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
/** "Sunday, Nov 29" (or "Wednesday, Nov 25") from the church-local date. */
export const sundayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
/** What Planning Center showed when the leader went ahead despite the advice, in the past. */
function adviceFact(check: BackgroundCheck, first: string): string {
  const of = first === "them" ? "their" : `${first}'s`, forThem = first === "them" ? "them" : first;
  switch (check) {
    case "current": return "";
    case "none-on-file": return `Planning Center showed no current background check on file for ${forThem}.`;
    case "pending": return `Planning Center showed a background check for ${forThem} that wasn't finished yet.`;
    case "expired": return `Planning Center showed ${of} background check on file was no longer current.`;
    case "expires-by-that-sunday": return `Planning Center showed ${of} background check on file had an end date on or before that service's day.`;
    case "could-not-read": return `Ozzie couldn't read ${of} background check in Planning Center.`;
  }
}
/**
 * One record in plain words. `name` the person's full name as shown, or "a person" when Ozzie can't name them; `service`
 * the service's own name when known (several services watched: two on one day are told apart).
 */
export function historyLine(r: ChangeRecord, name: string, service: string | null = null): string {
  const first = name === "a person" ? "them" : firstName(name);
  const where = service ? `${r.role} on ${planWords(service, sundayLabel(r.sunday))}` : `${r.role} on ${sundayLabel(r.sunday)}`;
  if (r.action === "added-unconfirmed") {
    const what = `You added ${name} to ${where} as unconfirmed, with the request waiting.`;
    const despite = r.despite_advice && r.despite_advice !== "current" ? ` Ozzie had advised against it: ${adviceFact(r.despite_advice, first)} You chose to go ahead.` : "";
    const back = r.came_back === "made" ? r.read_back === "as-expected" ? "Planning Center accepted it, and Ozzie saw it on the plan afterwards."
      : "Planning Center accepted it; Ozzie couldn't confirm it on the plan afterwards."
      : r.came_back === "made-after-all" ? "Planning Center didn't answer clearly; Ozzie looked again and found it on the plan."
        : r.came_back === "refused" ? "Planning Center didn't accept it, so nothing changed."
          : r.came_back === "nothing-changed" ? "Planning Center didn't answer clearly; Ozzie looked again and nothing had changed."
            : r.came_back === "several-rows" ? `Planning Center didn't answer clearly; Ozzie looked again and found ${first} on the plan more than once.`
            : "Planning Center's answer didn't make clear whether it was made.";
    return `${what}${despite} ${back}`;
  }
  const what = `You took ${name} off ${where}.`;
  const back = r.came_back === "removed" ? "Planning Center removed it."
    : r.came_back === "already-gone" ? `${first === "them" ? "They were" : `${first} was`} already off the plan.`
      : r.came_back === "refused" ? "Planning Center didn't accept it, so nothing changed."
        : r.came_back === "nothing-changed" ? "Nothing changed."
          : r.came_back === "several-rows" ? `Planning Center didn't answer clearly; Ozzie looked again and found ${first} on the plan more than once.`
          : "Planning Center's answer didn't make clear whether it was done.";
  return `${what} ${back}`;
}
