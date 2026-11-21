import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { buildSpokenBriefing, type BriefingInput } from "../../../core/src/spoken-briefing.js";
import { useDay } from "./day-words.js";
import { useTeamServices } from "./team-labels.js";

/** Native, on this Mac only: macOS speech with a fixed voice. The script never goes to an AI model. */
export const briefingVoice = {
  /** Resolves when playback ends or is stopped. */
  speak: (text: string) => invoke<"finished" | "stopped">("speak_briefing", { text }),
  stop: () => invoke<void>("stop_briefing"),
};

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const minutes = (seconds: number) => { const m = Math.max(1, Math.round(seconds / 60)); return m === 1 ? "About a minute" : `About ${m} minutes`; };

function PlayIcon() {
  return <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5-10-6.5Z" /></svg>;
}
function StopIcon() {
  return <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z" /></svg>;
}
function Chevron() {
  return <svg className="ic ic-sm chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;
}

/** "Listen to today's briefing": a compact bar that reads this page's findings aloud. Stopping never marks anything done. */
export function BriefingPanel({ input, names, attentionTimeZone, timeZone = localZone() }: {
  input: BriefingInput; names: Readonly<Record<string, string>>; attentionTimeZone?: string;
  /** The service's times. When it is a church's own zone, the check's time still follows this Mac, as the Sunday page says it. */
  timeZone?: string;
}) {
  const [withNames, setWithNames] = useState(false);
  const [state, setState] = useState<"ready" | "playing" | "problem">("ready");
  // The written script stays folded away until asked for, or until the voice can't play it.
  const [showScript, setShowScript] = useState(false);
  const run = useRef(0);
  // The watched service's real day, for the lines said before a check has read it ("Wednesday hasn't been checked yet").
  const day = useDay();
  // With more than one service watched, each role is said with its service (team-labels.ts); undefined with one.
  const teamServices = useTeamServices();
  const briefing = useMemo(() => buildSpokenBriefing(input, {
    timeZone, checkedTimeZone: localZone(), includeNames: withNames, names, day, ...(attentionTimeZone ? { attentionTimeZone } : {}),
    ...(teamServices ? { teamServices } : {}),
  }), [input, names, withNames, timeZone, attentionTimeZone, day, teamServices]);
  const stop = () => {
    run.current++;
    setState("ready");
    void briefingVoice.stop().catch(() => undefined);
  };
  // Leaving Today stops the voice.
  useEffect(() => () => { run.current++; void briefingVoice.stop().catch(() => undefined); }, []);
  const play = () => {
    const mine = ++run.current;
    setState("playing");
    briefingVoice.speak(briefing.text)
      .then(() => { if (run.current === mine) setState("ready"); })
      .catch(() => { if (run.current === mine) { setState("problem"); setShowScript(true); } });
  };
  const playing = state === "playing";
  return <section className="find listen" aria-labelledby="listen-title">
    <div className="listen-bar">
      <div className="listen-head">
        <h2 id="listen-title" className="listen-t">Listen to today's briefing</h2>
        <p className="small">{minutes(briefing.seconds)}, read aloud by this Mac's own voice. Nothing is sent anywhere to make it.</p>
      </div>
      <div className="listen-controls">
        {playing
          ? <button type="button" className="btn btn-secondary btn-sm" onClick={stop}><StopIcon />Stop</button>
          : <button type="button" className="btn btn-primary btn-sm" onClick={play}><PlayIcon />Play</button>}
        <label className="confirmation listen-names">
          <input type="checkbox" checked={withNames} onChange={e => { if (playing) stop(); setWithNames(e.target.checked); }} />
          <span>Include names</span>
        </label>
      </div>
    </div>
    <p className="small" role="status" aria-live="polite">{playing ? "Playing on this Mac. Stop any time; that doesn't mark anything done."
      : state === "problem" ? "This Mac couldn't play the briefing. The written version is open below."
        : withNames ? "Names are on for this briefing. They're read aloud on this Mac only." : "Names and private details are left out. Stopping or skipping doesn't mark anything done."}</p>
    <details className="listen-more" open={showScript} onToggle={e => setShowScript(e.currentTarget.open)}>
      <summary><Chevron />{showScript ? "Hide what will be read" : "Show what will be read"}</summary>
      <div className="listen-script" aria-label="Written briefing">
        {briefing.sections.map(s => <div key={s.id} className="listen-part">
          {s.heading && <p className="listen-h">{s.heading}</p>}
          <p>{s.sentences.join(" ")}</p>
        </div>)}
      </div>
    </details>
  </section>;
}
