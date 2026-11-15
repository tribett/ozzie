// "Open in Mail" and "Open in Messages" beside "Copy draft" (owner decisions, 2026-11-15): the draft opens as a new,
// unsent message in the person's own email app or Messages, for them to choose who it goes to, check and send. Ozzie
// never sends anything. Native code (src-tauri/src/draft_apps.rs) builds the mailto: or sms: address from the draft's
// words alone, so the page can't name an address, a recipient or another app. A mailto: address opens in the email app
// set on this Mac, which may not be Apple Mail: the Mac's reply names the app, and that name is what's said. The words
// are the same ones "Copy draft" copies, with names already put back on this Mac; nothing here goes to an AI.
import { useId, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

export type DraftApp = "mail" | "messages";
export const DRAFT_APPS: readonly DraftApp[] = ["mail", "messages"];
/** How the last open went, for the words it was asked with (a changed draft starts fresh), and the app it opened in. */
export interface HandOff { app: DraftApp; result: "opened" | "too-long" | "not-opened" | "failed"; text: string; in?: string }
export type OpenDraft = (app: DraftApp, body: string) => Promise<unknown>;
/** Native: opens `body` as a new, unsent message and replies `{ app }`, the app it opened in; or rejects with a closed code. */
export const openDraftNatively: OpenDraft = (app, body) => invoke<unknown>("open_draft", { app, body });

const APP_NAME: Record<DraftApp, string> = { mail: "Mail", messages: "Messages" };
export const openLabel = (app: DraftApp) => `Open in ${APP_NAME[app]}`;
/** No address is ever filled in: Ozzie reads no email addresses or phone numbers from Planning Center. */
export const HAND_OFF_NOTE = "Opens a new message in this Mac's email app or Messages, with no one in To: you choose who it goes to, check it and send it yourself.";

/** The app name in the Mac's reply, when it is one plain line; otherwise the usual name. */
export function openedIn(reply: unknown, app: DraftApp): string {
  const raw = reply && typeof reply === "object" ? (reply as { app?: unknown }).app : undefined;
  const name = typeof raw === "string" ? raw.trim() : "";
  return name && [...name].length <= 64 && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : APP_NAME[app];
}

export function handOffText({ app, result, in: opened }: HandOff): string {
  const name = APP_NAME[app];
  switch (result) {
    case "opened": return `Opened in ${opened ?? name} — check it and send it yourself`;
    case "too-long": return `This draft is too long to open in ${name}. Copy it instead.`;
    case "not-opened": return `${name} couldn't be opened on this Mac. Copy the draft instead.`;
    default: return `This draft couldn't be opened in ${name}. Copy it instead.`;
  }
}

/** Opens the draft; never throws. Only a reply from the Mac that it opened counts as opened. */
export async function handOff(app: DraftApp, text: string, open: OpenDraft = openDraftNatively): Promise<HandOff> {
  try {
    const reply = await open(app, text);
    return { app, result: "opened", text, in: openedIn(reply, app) };
  } catch (error) {
    return { app, result: error === "too-long" ? "too-long" : error === "not-opened" ? "not-opened" : "failed", text };
  }
}

/**
 * A draft's actions: its own copy button first (`copy`), then Open in Mail and Open in Messages, then anything else
 * (`after`). With `split`, the two open buttons get a row of their own under the copy row, so four buttons never wrap
 * raggedly. What happened is said under the buttons; the note says who chooses the recipient and who sends.
 */
export function DraftActions({ text, copy, after, small = false, split = false, describedBy, open = openDraftNatively, initial = null }: {
  /** Exactly the words "Copy draft" copies. */
  text: string; copy: ReactNode; after?: ReactNode; small?: boolean; split?: boolean; describedBy?: string | undefined;
  open?: OpenDraft | undefined;
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
    try { setLast(await handOff(app, text, open)); } finally { setBusy(false); }
  };
  const describe = describedBy ? `${noteId} ${describedBy}` : noteId;
  const opens = DRAFT_APPS.map(app => <button key={app} type="button" className={`btn btn-secondary${small ? " btn-sm" : ""}`} aria-describedby={describe}
    onClick={() => { void go(app); }}>{openLabel(app)}</button>);
  return <div className="draft-actions">
    {split
      ? <><div className="find-next">{copy}{after}</div><div className="find-next draft-open">{opens}</div></>
      : <div className="find-next">{copy}{opens}{after}</div>}
    <p className="small draft-opened" role="status" aria-live="polite">{shown?.result === "opened" ? handOffText(shown) : ""}</p>
    {shown && shown.result !== "opened" && <p role="alert" className="problem">{handOffText(shown)}</p>}
    <p className="small draft-note" id={noteId}>{HAND_OFF_NOTE}</p>
  </div>;
}
