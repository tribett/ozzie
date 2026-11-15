// Settings → Other AI apps, while "Use Ozzie's last check in other AI apps" is on: how to add Ozzie to an AI app on
// this Mac. The setup text names the helper bundled inside this Ozzie (ozzie-share, src-tauri/helpers/share.swift; its
// real path comes from native `share_helper_path`), which the other app starts by itself. Nothing here shares anything:
// the switch does, and this only explains what the other app will and won't see.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export const SETUP_SEES = "That app sees Ozzie's last check with labels like [Person 1] instead of names, the Church rules, and a list of what Ozzie ran and how it ended.";
export const SETUP_NEVER = "It never sees a name, a background check or anything you asked Ozzie, and it can't check Planning Center, change anything or send anything. What that app keeps is up to that app and its privacy terms.";
export const SETUP_STEPS = [
  "In Claude, open Settings, choose Developer, then Edit Config.",
  "Paste the setup text into the file that opens, and save it. If the file already lists other apps, put the \"ozzie\" part beside them instead of replacing them.",
  "Quit Claude and open it again. Then ask Claude, for example, \"What still needs attention for Sunday in Ozzie?\"",
] as const;
export const SETUP_MISSING = "Ozzie couldn't find the part of itself that other AI apps start. Installing Ozzie again puts it back.";
export const SETUP_MOVE = "Move Ozzie to your Applications folder and open it from there first. Right now it runs from a temporary copy or a disk that can be ejected, so other AI apps couldn't rely on finding it.";

/** The text an AI app's settings file needs: the bundled helper's real path, run with no arguments. */
export const setupText = (path: string): string => JSON.stringify({ mcpServers: { ozzie: { command: path } } }, null, 2);
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

/**
 * The setup steps, shown only while sharing is on. `path` (tests): the helper's path, or null when there is none,
 * instead of asking native.
 */
export function OtherAiAppsSetup({ on, path, find = findHelper }: { on: boolean; path?: string | null; find?: () => Promise<string | null> }) {
  const [found, setFound] = useState<string | null | undefined>(path);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (!on || path !== undefined) return;
    let live = true;
    find().then(p => { if (live) setFound(typeof p === "string" && p ? p : null); }, () => { if (live) setFound(null); });
    return () => { live = false; };
  }, [on, path, find]);
  if (!on || found === undefined) return null;
  return <div className="stack-tight" role="group" aria-labelledby="other-ai-setup-title" style={{ marginTop: 12 }}>
    <p id="other-ai-setup-title" className="bold">Add Ozzie to an AI app on this Mac</p>
    <p className="small">{SETUP_SEES} {SETUP_NEVER}</p>
    {found === null ? <p className="small">{SETUP_MISSING}</p>
      : temporaryPath(found) ? <p className="small">{SETUP_MOVE}</p>
        : <>
          <p className="small">For Claude on this Mac:</p>
          <ol className="ask-steps">{SETUP_STEPS.map(step => <li key={step}>{step}</li>)}</ol>
          <p className="small">Setup text:</p>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}><code>{setupText(found)}</code></pre>
          <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => { void copySetup(setupText(found)).then(ok => setCopy(ok ? "copied" : "failed")); }}>
            {copy === "copied" ? "Copied" : "Copy setup text"}</button></div>
          {copy === "failed" && <p role="alert" className="problem">The setup text couldn't be copied. Select it and copy it yourself.</p>}
          <p className="small">Other AI apps that can start a program on this Mac use the same setup text. If you move Ozzie to another folder, come back here for new setup text.</p>
        </>}
  </div>;
}
