// "Open in Mail" and "Open in Messages" beside "Copy draft" (owner decisions, 2026-11-15): the draft opens as a new,
// unsent message in the person's own email app or Messages, for them to check and send. Ozzie never sends anything.
// Native code (src-tauri/src/draft_apps.rs) builds the mailto: or sms: address, so the page can't name an address or
// another app. A mailto: address opens in the email app set on this Mac, which may not be Apple Mail: the Mac's reply
// names the app, and that name is what's said. The words are the same ones "Copy draft" copies, with names already put
// back on this Mac; nothing here goes to an AI.
//
// A note prepared on the Sunday page for one person (audit item 19, owner decision 2026-11-16) opens with
// `open_draft_to`: the page sends the app, the words and that person's Planning Center id from the check it shows, never
// anything typed, listed or read from a card, and native code reads that person's email address or mobile number to
// fill in To. The page never receives the address or number: only whether To was filled in, or a closed code for why
// not, which it says in its own words with the name it already shows. Notes for no one in particular (Ask's, Today's)
// open as before, with To empty.
import { useId, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

export type DraftApp = "mail" | "messages";
export const DRAFT_APPS: readonly DraftApp[] = ["mail", "messages"];
/** Why a note for one person opened with To empty (native core `contact` NoRecipient): closed codes that carry nothing. */
export const NO_RECIPIENT = ["none-on-file", "not-allowed", "could-not-read", "more-than-one", "child", "not-in-this-check", "busy-with-a-check",
  "busy-with-another-note", "too-many-just-now"] as const;
export type NoRecipient = (typeof NO_RECIPIENT)[number];
/**
 * How the last open went, for the words it was asked with (a changed draft starts fresh), and the app it opened in.
 * "addressed": opened with the person in To; "unaddressed": opened with To empty, and `reason` why when native said one
 * of the closed codes. Only these codes and the app's name are kept from a reply: never an address or a number.
 */
export interface HandOff {
  app: DraftApp; result: "opened" | "addressed" | "unaddressed" | "too-long" | "not-opened" | "failed"; text: string; in?: string; reason?: NoRecipient | null;
}
export type OpenDraft = (app: DraftApp, body: string) => Promise<unknown>;
/** Native: opens `body` as a new, unsent message and replies `{ app }`, the app it opened in; or rejects with a closed code. */
export const openDraftNatively: OpenDraft = (app, body) => invoke<unknown>("open_draft", { app, body });
export type OpenDraftTo = (app: DraftApp, body: string, person: string) => Promise<unknown>;
/**
 * Native: opens `body` addressed to `person` (a Planning Center id from the check on screen) when Planning Center has one
 * usable email address or mobile number for them; replies `{ app, result, reason? }`, or rejects as `open_draft` does.
 */
export const openDraftToNatively: OpenDraftTo = (app, body, person) => invoke<unknown>("open_draft_to", { app, body, person });
/** A Planning Center id as native code accepts one (oauth.rs `numeric_id`): digits, no leading zero. */
export const isPersonId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,31}$/u.test(v);
/**
 * Who a prepared note is for: the Planning Center id the check on screen holds for them, the name the page shows (or
 * "this person"), whether the saved sign-in includes People (where email addresses and phone numbers are kept), and
 * Settings, where signing in again with People is the leader's own click.
 */
export interface Addressee { person: string; name: string; peopleGranted: boolean; onAddPeople?: (() => void) | undefined }

const APP_NAME: Record<DraftApp, string> = { mail: "Mail", messages: "Messages" };
export const openLabel = (app: DraftApp) => `Open in ${APP_NAME[app]}`;
/** The app a note opened in, when the Mac's reply doesn't name it plainly: by the button pressed, in native's own neutral
 *  words, since the app this Mac opens the link with may not be Mail or Messages (review F L-8, review G L-c). Both
 *  open_draft (a note for no one in particular) and open_draft_to name the real app or say the neutral words, and both
 *  replies are read the same way (`openedIn`). "Mail" and "Messages" are said only when the reply names that app. */
const SOME_APP: Record<DraftApp, string> = { mail: "your email app", messages: "your messages app" };
/** A note for no one in particular (Ask's, Today's): To stays empty. */
export const HAND_OFF_NOTE = "Opens a new message in this Mac's email app or Messages, with no one in To: you choose who it goes to, check it and send it yourself.";
/** A note for one person on the Sunday page: when To is filled (native contact.rs `choose`: the only usable one, or the
 *  one marked primary), and that what's read is kept nowhere (review P, L8). */
export const handOffToNote = (name: string) => `Opens a new message in this Mac's email app or Messages addressed to ${name} when Planning Center has one usable email address or mobile number for them, or marks one as primary. What's read is used only to fill in To: never kept and never sent to AI. Check it and send it yourself.`;
/** Below a note opened with To empty because the sign-in doesn't include People: the leader's own way to add it. */
export const ADD_PEOPLE = "Open Settings to sign in again with People";

/** The app name in the Mac's reply, when it is one plain line; otherwise what kind of app it was ("your email app"). */
export function openedIn(reply: unknown, app: DraftApp): string {
  const raw = reply && typeof reply === "object" ? (reply as { app?: unknown }).app : undefined;
  const name = typeof raw === "string" ? raw.trim() : "";
  return name && [...name].length <= 64 && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : SOME_APP[app];
}

/** Whether a note for one person opened with To empty because the sign-in doesn't include People (not a refusal about them). */
export const needsPeople = (h: Pick<HandOff, "result" | "reason">, to: Pick<Addressee, "peopleGranted"> | null | undefined) =>
  h.result === "unaddressed" && h.reason === "not-allowed" && !to?.peopleGranted;
/** What happened to a note for one person, in the page's own words with the name it already shows. */
export function addressedText(h: HandOff, to: Pick<Addressee, "name" | "peopleGranted">): string {
  const opened = h.in ?? SOME_APP[h.app];
  const detail = h.app === "mail" ? "email address" : "mobile number";
  const empty = `The note opened in ${opened} with To empty`;
  if (h.result === "addressed") return `Opened in ${opened}, addressed to ${to.name}. Check it and send it yourself.`;
  switch (h.reason) {
    case "none-on-file": return h.app === "mail" ? `Planning Center has no email address for ${to.name} that can be used. ${empty}.` : `Planning Center has no mobile number for ${to.name}. ${empty}.`;
    case "not-allowed": return needsPeople(h, to)
      ? `Ozzie's Planning Center sign-in doesn't include People, where email addresses and phone numbers are kept. ${empty}.`
      // Native's not-allowed is also Planning Center refusing the read, or this Mac's Keychain refusing Ozzie its saved
      // sign-in (contact.rs NotAllowed; a locked Keychain is could-not-read).
      : `Ozzie wasn't allowed to read ${to.name}'s ${detail} just now: Planning Center or this Mac's Keychain refused. ${empty}.`;
    case "could-not-read": return `Ozzie couldn't read ${to.name}'s ${detail} from Planning Center just now. ${empty}.`;
    // Several usable ones and none marked primary, or more than one marked primary (contact.rs `choose`).
    case "more-than-one": return `Planning Center has more than one ${detail} for ${to.name} and doesn't mark exactly one as primary. ${empty}, for you to choose.`;
    case "child": return `Planning Center lists ${to.name} as a child, so To is left empty. The note opened in ${opened}.`;
    // Someone a check of the church in use handed the page since Ozzie opened (contact.rs NotInThisCheck).
    case "not-in-this-check": return `Ozzie fills in To only for people a Sunday check of the church Ozzie is using has shown since Ozzie opened. ${empty}.`;
    // A Sunday check or setup's plan picker was reading Planning Center (contact.rs BusyWithACheck).
    case "busy-with-a-check": return `Ozzie was reading Planning Center just then, so To was left empty. The note opened in ${opened}.`;
    case "busy-with-another-note": return `Ozzie was still filling in To for another note, so To was left empty. The note opened in ${opened}.`;
    // Native allows READS_PER_MINUTE (10) reads in the past minute, whether or not they filled in To (contact.rs).
    case "too-many-just-now": return `Ozzie has already read from Planning Center 10 times in the last minute, so To was left empty. The note opened in ${opened}.`;
    default: return `Ozzie couldn't read ${to.name}'s ${detail} from Planning Center just now. ${empty}.`;
  }
}

export function handOffText({ app, result, in: opened }: HandOff): string {
  const name = SOME_APP[app];
  switch (result) {
    case "opened": case "addressed": case "unaddressed": return `Opened in ${opened ?? name} — check it and send it yourself`;
    case "too-long": return `This draft is too long to open in ${name}. Copy it instead.`;
    case "not-opened": return `${name.charAt(0).toUpperCase()}${name.slice(1)} couldn't be opened on this Mac. Copy the draft instead.`;
    default: return `This draft couldn't be opened in ${name}. Copy it instead.`;
  }
}

const failedAs = (error: unknown): HandOff["result"] => error === "too-long" ? "too-long" : error === "not-opened" ? "not-opened" : "failed";
/** Opens the draft; never throws. Only a reply from the Mac that it opened counts as opened. */
export async function handOff(app: DraftApp, text: string, open: OpenDraft = openDraftNatively): Promise<HandOff> {
  try {
    const reply = await open(app, text);
    return { app, result: "opened", text, in: openedIn(reply, app) };
  } catch (error) {
    return { app, result: failedAs(error), text };
  }
}
/**
 * Opens a note for one person, addressed when Planning Center has one usable detail for them; never throws. Only
 * "addressed" counts as addressed; any other reply from a Mac that opened the note is To empty, with the closed code when
 * it is one. Nothing else of the reply is kept. A person id that isn't a Planning Center id is never sent: that note opens
 * as an unaddressed one.
 */
export async function handOffTo(app: DraftApp, text: string, person: string, openTo: OpenDraftTo = openDraftToNatively, open: OpenDraft = openDraftNatively): Promise<HandOff> {
  if (!isPersonId(person)) return handOff(app, text, open);
  try {
    const reply = await openTo(app, text, person);
    const said = reply && typeof reply === "object" ? reply as { result?: unknown; reason?: unknown } : {};
    if (said.result === "addressed") return { app, result: "addressed", text, in: openedIn(reply, app) };
    // Opened, but not addressed: a reason the page doesn't know (native may add one) is said as could-not-read, never as
    // an error, since the note did open.
    const reason: NoRecipient = (NO_RECIPIENT as readonly unknown[]).includes(said.reason) && said.result === "opened-without-recipient" ? said.reason as NoRecipient : "could-not-read";
    return { app, result: "unaddressed", reason, text, in: openedIn(reply, app) };
  } catch (error) {
    return { app, result: failedAs(error), text };
  }
}

/**
 * A draft's actions: its own copy button first (`copy`), then Open in Mail and Open in Messages, then anything else
 * (`after`). With `split`, the two open buttons get a row of their own under the copy row, so four buttons never wrap
 * raggedly. What happened is said under the buttons; the note says how To is filled in (or that the leader fills it in)
 * and who sends. What happened stays on this card only: a reason such as "child" is a fact about a person, so it is
 * never kept, recorded or passed on (product/desktop/test/draft-actions.test.ts).
 */
export function DraftActions({ text, copy, after, small = false, split = false, describedBy, open = openDraftNatively, openTo = openDraftToNatively, to = null, initial = null }: {
  /** Exactly the words "Copy draft" copies. */
  text: string; copy: ReactNode; after?: ReactNode; small?: boolean; split?: boolean; describedBy?: string | undefined;
  open?: OpenDraft | undefined;
  /** Who the note is for, on the Sunday page: then it opens addressed when it can (tests replace the Mac's `openTo`). */
  to?: Addressee | null | undefined; openTo?: OpenDraftTo | undefined;
  /** Start as if an open already happened (tests). */
  initial?: HandOff | null;
}) {
  const [last, setLast] = useState<HandOff | null>(initial);
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const shown = last && last.text === text ? last : null;
  const go = async (app: DraftApp) => {
    if (busy) return;
    setBusy(true);
    try { setLast(await (to ? handOffTo(app, text, to.person, openTo, open) : handOff(app, text, open))); } finally { setBusy(false); }
  };
  const describe = describedBy ? `${noteId} ${describedBy}` : noteId;
  const opens = DRAFT_APPS.map(app => <button key={app} type="button" className={`btn btn-secondary${small ? " btn-sm" : ""}`} aria-describedby={describe}
    onClick={() => { void go(app); }}>{openLabel(app)}</button>);
  return <div className="draft-actions">
    {split
      ? <><div className="find-next">{copy}{after}</div><div className="find-next draft-open">{opens}</div></>
      : <div className="find-next">{copy}{opens}{after}</div>}
    <p className="small draft-opened" role="status" aria-live="polite">{!shown ? "" : shown.result === "opened" ? handOffText(shown)
      : shown.result === "addressed" || shown.result === "unaddressed" ? addressedText(shown, to ?? { name: "this person", peopleGranted: true }) : ""}</p>
    {shown && needsPeople(shown, to) && to?.onAddPeople && <div className="find-next">
      <button type="button" className="btn btn-secondary btn-sm" onClick={to.onAddPeople}>{ADD_PEOPLE}</button></div>}
    {shown && (shown.result === "too-long" || shown.result === "not-opened" || shown.result === "failed") && <p role="alert" className="problem">{handOffText(shown)}</p>}
    <p className="small draft-note" id={noteId}>{to ? handOffToNote(to.name) : HAND_OFF_NOTE}</p>
  </div>;
}
