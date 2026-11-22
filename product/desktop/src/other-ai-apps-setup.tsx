// Settings → Other AI apps, while "Use Ozzie's last check in other AI apps" is on: ready-made setup for the AI apps
// on this Mac. The person picks their app and gets the exact text and steps for it (core/mcp/setup.ts); for Claude,
// "Add Ozzie to Claude" has native make the small file Claude opens by itself (src-tauri/src/share_bundle.rs), and
// Claude then asks the person whether to install it. Every text names the helper bundled inside this Ozzie
// (ozzie-share, src-tauri/helpers/share.swift; its real path comes from native `share_helper_path`), which the other
// app starts by itself. Nothing here shares anything: the switch does, and this only explains what the other app will
// and won't see.
import { invoke } from "@tauri-apps/api/core";
import { Fragment, useEffect, useState } from "react";
import { Icon } from "./icons.js";
import { SETUP_APPS, setupApp, usablePath, type SetupApp, type SetupAppId } from "../../../core/mcp/setup.js";

export const SETUP_SEES = "That app sees Ozzie's last check with labels like [Person 1] instead of names, the Church rules, and a list of what Ozzie ran and how it ended.";
export const SETUP_NEVER = "It never sees the names Ozzie read from Planning Center, a background check or anything you asked Ozzie, and it can't check Planning Center, change anything or send anything. What that app keeps is up to that app and its privacy terms.";
/** The steps for Claude by hand (the same list every app's steps come from). */
export const SETUP_STEPS = setupApp("claude").steps;
export const SETUP_MISSING = "Ozzie couldn't find the part of itself that other AI apps start. Installing Ozzie again puts it back.";
export const SETUP_MOVE = "Move Ozzie to your Applications folder and open it from there first. Right now it runs from a temporary copy or a disk that can be ejected, so other AI apps couldn't rely on finding it.";

export const SETUP_ODD = "Other AI apps can't be given the folder Ozzie is in now. Move Ozzie to your Applications folder and open it from there first.";
export const SETUP_WHICH = "Which app?";
export const ADD_TO_CLAUDE = "Add Ozzie to Claude";
// What Claude does with the file was seen on 2026-11-16 (Claude for Mac 5.11492.5, docs/build/DEMO-STATUS.md): it
// shows Ozzie's description and tools with an Install button, a warning it gives for every file of this kind, and a
// second question to confirm; then it starts the helper.
export const ADD_BODY = "Ozzie hands Claude a small setup file. Claude shows what it will add and asks you to install it; nothing is added until you agree there.";
export const ADD_WARNING = "Claude also warns that it hasn't verified the file and that anything installed this way can reach everything on your Mac. It says that about every file of this kind. What Claude starts is the part of Ozzie that reads Ozzie's copy and nothing else.";
export const ADD_OPENED = "Ozzie handed Claude its setup file. In Claude, choose Install, then Install again to confirm. Then ask Claude, for example, \"What still needs attention in Ozzie's last check?\" If nothing appears in Claude, set it up by hand below.";
export const ADD_BY_HAND = "Set it up by hand instead";
export const SETUP_MOVED = "If you move Ozzie to another folder, come back here and set it up again.";
/** What the person is told when "Add Ozzie to Claude" couldn't finish, by native's code (share_bundle.rs). */
export const ADD_PROBLEMS: Readonly<Record<string, string>> = {
  "no-helper": SETUP_MISSING,
  "move-first": SETUP_MOVE,
  "not-saved": "Ozzie couldn't save the setup file for Claude. Try again, or set it up by hand below.",
  "not-opened": "Ozzie couldn't open Claude on this Mac. If Claude is installed, open it once and try again, or set it up by hand below.",
};
export const addProblem = (code: unknown): string => (typeof code === "string" && Object.hasOwn(ADD_PROBLEMS, code) ? ADD_PROBLEMS[code]! : ADD_PROBLEMS["not-opened"]!);

/** The text Claude's settings file needs: the bundled helper's real path, run with no arguments. */
export const setupText = (path: string): string => setupApp("claude").text(path);
/**
 * Where the setup text wouldn't last: macOS's temporary copy of a downloaded app that hasn't been moved (its path changes),
 * or Ozzie.app opened straight from its disk image or another disk (gone when that disk is ejected).
 */
export const temporaryPath = (path: string): boolean => path.includes("/AppTranslocation/") || (/^\/Volumes\//u.test(path) && path.includes(".app/Contents/MacOS/"));

type Clipboard = { writeText(text: string): Promise<void> } | undefined;
/** True only once the text is on the clipboard; a missing or refusing clipboard is false, never success. */
export async function copySetup(text: string, clipboard: Clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard): Promise<boolean> {
  if (!clipboard) return false;
  try { await clipboard.writeText(text); return true; } catch { return false; }
}
const findHelper = () => invoke<string | null>("share_helper_path");
const addToClaude = () => invoke<null>("add_to_claude");

/** A step's words, with a file or folder name between backticks shown as one. */
const Step = ({ text }: { text: string }) => <>{text.split("`").map((part, i) => <Fragment key={i}>{i % 2 ? <code>{part}</code> : part}</Fragment>)}</>;

/** One app's steps and its exact text with a Copy button. */
function ByHand({ app, path }: { app: SetupApp; path: string }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const text = app.text(path);
  return <>
    <ol className="ask-steps">{app.steps.map(step => <li key={step}><Step text={step} /></li>)}</ol>
    <p className="small">{app.textLabel}:</p>
    <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}><code>{text}</code></pre>
    <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => { void copySetup(text).then(ok => setCopy(ok ? "copied" : "failed")); }}>
      {copy === "copied" ? "Copied" : "Copy"}</button></div>
    {copy === "failed" && <p role="alert" className="problem">It couldn't be copied. Select it and copy it yourself.</p>}
    {app.pathLabel && <>
      <p className="small">{app.pathLabel}:</p>
      <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}><code>{path}</code></pre>
    </>}
  </>;
}

/** Claude: one button that hands Claude the setup file, with the steps by hand folded away beneath. */
function ForClaude({ app, path, add }: { app: SetupApp; path: string; add: () => Promise<unknown> }) {
  const [state, setState] = useState<"idle" | "adding" | "opened" | { problem: string }>("idle");
  return <>
    <p className="small">{ADD_BODY} {ADD_WARNING}</p>
    <div><button type="button" className="btn btn-primary btn-sm" disabled={state === "adding"} onClick={() => {
      setState("adding");
      add().then(() => setState("opened"), code => setState({ problem: addProblem(code) }));
    }}>{ADD_TO_CLAUDE}</button></div>
    {state === "opened" && <p role="status" className="small">{ADD_OPENED}</p>}
    {typeof state === "object" && <p role="alert" className="problem">{state.problem}</p>}
    <details className="listen-more">
      <summary><Icon name="chev" small />{ADD_BY_HAND}</summary>
      <div className="stack-tight"><ByHand app={app} path={path} /></div>
    </details>
  </>;
}

/**
 * The ready-made setup, shown only while sharing is on. `path` (tests): the helper's path, or null when there is
 * none, instead of asking native. `app` (tests): the app shown first.
 */
export function OtherAiAppsSetup({ on, path, find = findHelper, add = addToClaude, app = "claude" }: { on: boolean; path?: string | null; find?: () => Promise<string | null>; add?: () => Promise<unknown>; app?: SetupAppId }) {
  const [found, setFound] = useState<string | null | undefined>(path);
  const [chosen, setChosen] = useState<SetupAppId>(app);
  useEffect(() => {
    if (!on || path !== undefined) return;
    let live = true;
    find().then(p => { if (live) setFound(typeof p === "string" && p ? p : null); }, () => { if (live) setFound(null); });
    return () => { live = false; };
  }, [on, path, find]);
  if (!on || found === undefined) return null;
  const current = setupApp(chosen);
  return <div className="stack-tight" role="group" aria-labelledby="other-ai-setup-title" style={{ marginTop: 12 }}>
    <p id="other-ai-setup-title" className="bold">Add Ozzie to an AI app on this Mac</p>
    <p className="small">{SETUP_SEES} {SETUP_NEVER}</p>
    {found === null ? <p className="small">{SETUP_MISSING}</p>
      : temporaryPath(found) ? <p className="small">{SETUP_MOVE}</p>
        : !usablePath(found) ? <p className="small">{SETUP_ODD}</p>
          : <>
            <div className="setup-apps" role="group" aria-label={SETUP_WHICH}>
              <span className="small">{SETUP_WHICH}</span>
              {/* The chosen app shows a tick and a thicker edge, not only a paler fill (accessibility audit M9). */}
              {SETUP_APPS.map(a => <button key={a.id} type="button" className="chip" aria-pressed={a.id === chosen} onClick={() => setChosen(a.id)}>
                {a.id === chosen && <Icon name="check" small />}{a.name}</button>)}
            </div>
            {/* keyed, so a "Copied" or an "opened" line never carries over to another app */}
            {current.oneClick ? <ForClaude key={current.id} app={current} path={found} add={add} /> : <ByHand key={current.id} app={current} path={found} />}
            <p className="small">{SETUP_MOVED}</p>
          </>}
  </div>;
}
