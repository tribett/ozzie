// Settings → Siri and Shortcuts: the "Let Siri and Shortcuts ask Ozzie" switch (siri-shortcuts.ts), what Siri and
// Shortcuts can and can't hear, and, while it's on, how to ask. First Ozzie's own Siri actions (ADR 0007), when this
// Ozzie carries them (native `siri_actions_bundled`): nothing to set up. Then, as the fallback, the steps to make the two
// shortcuts by hand; the command names the helper bundled inside this Ozzie (ozzie-shortcuts; its real path comes from
// native `shortcuts_helper_path`). Nothing here answers anything: the actions and the helper do, from the copy the
// switch keeps.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { copySetup, temporaryPath } from "./other-ai-apps-setup.js";
import type { ShortcutsSettings } from "./siri-shortcuts.js";

export const SIRI_BODY = "Ask Ozzie from Spotlight without opening this window, for example \"Is Sunday covered?\" The answer comes from Ozzie's last saved check on this Mac and always says when that check was made.";
export const SIRI_SEES = "Siri and Shortcuts hear counts and times from Ozzie's last check: open spots and how many roles they're in, how many people are pending, with and without a request sent, teams without a confirmed lead, kids teams with fewer confirmed people than your Church rules ask, what Ozzie isn't sure of as Worth a look, how many you marked as handled, whether part of the check couldn't be read or was too long to say in full, that some findings are shown only in Ozzie when your Church rules keep them there, and when it was checked.";
export const SIRI_NEVER = "They never hear a name, a role, team or room name, a background check or anything you asked Ozzie. Answering reads nothing from Planning Center, uses no AI help, and can't change or send anything. Siri hears your question as it hears any other; what Apple keeps is up to Apple.";
export const SIRI_HOW = [
  "While this is on, Ozzie keeps a small copy of its last check's Sunday overview on this Mac. People and roles appear in it only as labels like [Role 1], and answers don't say even those, only counts and times.",
  "When Spotlight or a shortcut asks, a small part of Ozzie reads that copy and answers. It doesn't open Ozzie's window or check Planning Center again.",
  "macOS lets Ozzie's own actions in Siri and Shortcuts read only that copy among Ozzie's files: not your saved checks, not the copy for other AI apps, not your documents, and nothing from Planning Center.",
  "When the check is more than 30 minutes old, the saved copy of an earlier check, Ozzie's fictional example, or marked with a time later than this Mac's clock, the answer says so. When there's no current check, it says that instead.",
  "A link like ozzie://sunday only opens that page in Ozzie, and only while this is on. A link can't ask Ozzie anything or change anything.",
  "Turning this off removes the copy. Siri and Shortcuts then hear only that this is turned off in Ozzie's Settings.",
  "Only a shortcut you make yourself with Run Shell Script needs Shortcuts' Allow Running Scripts setting, which lets every shortcut on this Mac run commands, not only Ozzie's. Ozzie's own actions don't need it.",
] as const;
/** Ozzie's own Siri actions (helpers/siri-actions.swift): what to say to Siri, and where they are in Shortcuts. */
/** The actions' own names (their titles in helpers/siri-actions.swift): what Spotlight finds and runs. */
export const ACTION_NAMES = ["Is Sunday covered", "Open Ozzie's Sunday page", "Open Ozzie's Today page"] as const;
export const ACTIONS_READY = "Once Ozzie is in your Applications folder and has been opened from there, press \u2318 Space, type one of these and choose Run:";
export const ACTION_PHRASES = ["Is Sunday covered in Ozzie?", "Open Sunday in Ozzie", "Open Today in Ozzie"] as const;
export const ACTIONS_IN_SHORTCUTS = "They are also listed in the Shortcuts app under Ozzie as Is Sunday covered, Open Ozzie's Sunday page and Open Ozzie's Today page, to use in shortcuts of your own.";
/**
 * Owner's spoken test and the coordinator's typed ones, 2026-11-16, macOS 27.2: the newest Siri ran neither Ozzie's
 * actions nor another app's of the same kind, while Spotlight ran Ozzie's. Said plainly rather than promised.
 */
export const ACTIONS_SIRI = `Siri: on macOS 27.2, Siri didn't run Ozzie's actions when this was checked. Asked "${"Is Sunday covered in Ozzie?"}", it may answer by itself, without Ozzie's check. Use Spotlight instead.`;
export const ACTIONS_NOT_FOUND = "If Spotlight or Shortcuts doesn't find them, move Ozzie to your Applications folder, open it from there, and try again.";
export const BY_HAND = "Make the shortcuts yourself instead";
export const ASK_NAME = "Is Sunday covered";
export const OPEN_NAME = "Open Ozzie's Sunday page";
export const OPEN_LINK = "ozzie://sunday";
/** Said before the steps (review K M3): the setting isn't Ozzie's, and it reaches every shortcut. */
export const SCRIPTS_SETTING = "Allow Running Scripts is a setting for all of Shortcuts on this Mac: once it's on, any shortcut you have or add later can run commands as you, not only Ozzie's, so only add shortcuts you trust. You can turn it off again in the same place; then \"Is Sunday covered\" stops answering.";
export const ASK_STEPS = [
  "Open the Shortcuts app. Choose Shortcuts > Settings, click Advanced and turn on Allow Running Scripts, which the Run Shell Script step needs.",
  `Choose File > New Shortcut and name it "${ASK_NAME}".`,
  "Add the Run Shell Script action and replace its text with the command below.",
  "Add the Show Result action, so the answer is shown. Add Speak Text too if you'd like it read aloud.",
  `Run it from Spotlight or the Shortcuts app.`,
] as const;
export const OPEN_STEPS = [
  `Choose File > New Shortcut and name it "${OPEN_NAME}".`,
  "Add the Open URLs action with the link below.",
  `Run it from Spotlight or the Shortcuts app.`,
] as const;
export const SHORTCUTS_MISSING = "Ozzie couldn't find the part of itself that answers Siri and Shortcuts. Installing Ozzie again puts it back.";
export const SHORTCUTS_MOVE = "Move Ozzie to your Applications folder and open it from there first. Right now it runs from a temporary copy or a disk that can be ejected, so a shortcut couldn't rely on finding it.";

/** The Run Shell Script text: the helper's real path in single quotes (any quote in it closed and escaped), then the question. */
export const askCommand = (path: string): string => `'${path.replace(/'/gu, "'\\''")}' sunday`;

const findHelper = () => invoke<string | null>("shortcuts_helper_path");
const findActions = () => invoke<boolean>("siri_actions_bundled");

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  return <>
    <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}><code>{text}</code></pre>
    <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => { void copySetup(text).then(ok => setCopy(ok ? "copied" : "failed")); }}>
      {copy === "copied" ? "Copied" : label}</button></div>
    {copy === "failed" && <p role="alert" className="problem">That couldn't be copied. Select it and copy it yourself.</p>}
  </>;
}

/** The two shortcuts made by hand with the helper at `found` (or why they can't be). */
function ByHand({ found }: { found: string | null }) {
  if (found === null) return <p className="small">{SHORTCUTS_MISSING}</p>;
  return <>
    <p className="small">"{ASK_NAME}" answers from Ozzie's last check.</p>
    <p className="small"><span className="bold">Before you start: </span>{SCRIPTS_SETTING}</p>
    <ol className="ask-steps">{ASK_STEPS.map(step => <li key={step}>{step}</li>)}</ol>
    <p className="small">Command:</p>
    <CopyLine text={askCommand(found)} label="Copy command" />
    <p className="small">"{OPEN_NAME}" opens Ozzie to Sunday. This one doesn't need Allow Running Scripts.</p>
    <ol className="ask-steps">{OPEN_STEPS.map(step => <li key={step}>{step}</li>)}</ol>
    <p className="small">Link:</p>
    <CopyLine text={OPEN_LINK} label="Copy link" />
    <p className="small">If you move Ozzie to another folder, come back here for the new command.</p>
  </>;
}

/**
 * How to ask, shown only while it's on: Ozzie's own Siri actions when this Ozzie carries them, with the shortcuts by hand
 * as the fallback; otherwise the shortcuts by hand. `path` (tests): the helper's path, or null, and `actions` (tests):
 * whether the Siri actions are bundled, instead of asking native.
 */
export function ShortcutsSetup({ on, path, actions, find = findHelper, findBundled = findActions }: {
  on: boolean; path?: string | null; actions?: boolean; find?: () => Promise<string | null>; findBundled?: () => Promise<boolean>;
}) {
  const [found, setFound] = useState<string | null | undefined>(path);
  const [bundled, setBundled] = useState<boolean | undefined>(actions);
  useEffect(() => {
    if (!on || path !== undefined) return;
    let live = true;
    find().then(p => { if (live) setFound(typeof p === "string" && p ? p : null); }, () => { if (live) setFound(null); });
    return () => { live = false; };
  }, [on, path, find]);
  useEffect(() => {
    if (!on || actions !== undefined) return;
    let live = true;
    findBundled().then(b => { if (live) setBundled(b === true); }, () => { if (live) setBundled(false); });
    return () => { live = false; };
  }, [on, actions, findBundled]);
  if (!on || found === undefined || bundled === undefined) return null;
  // A temporary copy or an ejectable disk: neither Siri nor a shortcut could rely on finding this Ozzie.
  const moved = found !== null && temporaryPath(found);
  return <div className="stack-tight" role="group" aria-labelledby="siri-setup-title" style={{ marginTop: 12 }}>
    <p id="siri-setup-title" className="bold">{bundled ? "Ask from Spotlight or Shortcuts" : "Make the shortcuts"}</p>
    {moved ? <p className="small">{SHORTCUTS_MOVE}</p>
      : !bundled ? <ByHand found={found} />
        : <>
          <p className="small">{ACTIONS_READY}</p>
          <ul className="small">{ACTION_NAMES.map(name => <li key={name}>{name}</li>)}</ul>
          <p className="small">{ACTIONS_IN_SHORTCUTS}</p>
          <p className="small">{ACTIONS_SIRI}</p>
          <p className="small">{ACTIONS_NOT_FOUND}</p>
          <details className="listen-more">
            <summary>{BY_HAND}</summary>
            <div className="stack-tight"><ByHand found={found} /></div>
          </details>
        </>}
  </div>;
}

/**
 * The Settings card, under "Other AI apps, Spotlight and Shortcuts" (audit item 27). `path` and `actions` (tests) are
 * passed to the setup steps.
 */
export function SiriShortcutsSection({ on, onChange, problem, path, actions }: ShortcutsSettings & { path?: string | null; actions?: boolean }) {
  return <section className="find" aria-labelledby="siri-title">
    <h3 id="siri-title" className="settings-t">Siri and Shortcuts</h3>
      <p className="find-body">{SIRI_BODY}</p>
      <div className="stack-tight">
        <label className="confirmation"><input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} />
          <span>Let Siri and Shortcuts ask Ozzie</span></label>
        <p className="small">Off unless you turn it on. Turning it off removes the copy they answer from.</p>
        {problem && <p role="alert" className="problem">{problem}</p>}
      </div>
      <p className="small" style={{ marginTop: 12 }}>{SIRI_SEES} {SIRI_NEVER}</p>
      <ShortcutsSetup on={on} {...(path !== undefined ? { path } : {})} {...(actions !== undefined ? { actions } : {})} />
      <details className="listen-more">
        <summary>See how this works</summary>
        <ul className="small">{SIRI_HOW.map(line => <li key={line}>{line}</li>)}</ul>
      </details>
  </section>;
}
