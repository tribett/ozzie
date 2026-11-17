import { OtherAiAppsSetup } from "./other-ai-apps-setup.js";
import { PhoneNoticeSection } from "./phone-notice-section.js";
import { SiriShortcutsSection } from "./siri-shortcuts-section.js";
import type { ShortcutsSettings } from "./siri-shortcuts.js";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { moreOf, operationsGranted, yourName, YOUR_NAME_MAX, type ConnectionStatus } from "./connection.js";
import { MoreFromPlanningCenter } from "./planning-center-more.js";
import type { Settings } from "./sunday-source.js";
import type { ProactivePrefs } from "./proactive.js";
import { AiSettings } from "./ai-settings.js";
import { ConnectForm, useConnectionControl } from "./planning-center-forms.js";
import { SundayPicker } from "./sunday-picker.js";
import { quietLine, scheduleLine } from "./proactive-page.js";
import { Icon } from "./icons.js";
import type { Autostart } from "./background.js";
import { AutostartToggle } from "./responsibility-views.js";

/** The access the saved connection was granted, known only once it's been checked this session. */
export function grantedCopy(status: ConnectionStatus | null): string {
  if (operationsGranted(status)) return "Granted: Services, Calendar, People and Groups. Ozzie reads rooms, follow-ups and group events.";
  if (status?.scopes) return "Granted: Services only. Rooms, follow-ups and group events aren't checked.";
  return "What's granted shows here once the connection has been checked.";
}

export const SHARE_BODY = "An AI app on this Mac, such as Claude, can use the same facts from Ozzie's last check that Ask Ozzie uses. People, roles and rooms are shown to it as labels like [Person 1]; their names stay here.";
export const SHARE_HOW = [
  "While this is on, Ozzie keeps one copy of its last check on this Mac, with every name replaced by a label. Ozzie checks it again for names before saving it.",
  "An AI app set up to use it can read that copy and a list of what Ozzie ran and how it ended. It can't check Planning Center, change anything or send anything.",
  "What that app keeps or does with what it reads is up to that app and its privacy terms, not Ozzie.",
  "Turning this on shows the setup text for an AI app here.",
] as const;

/**
 * How many checks are saved on this Mac (native "recordings"; a person sees "saved checks", never "recordings", which
 * sounds like audio: audit item 28), and deleting them. Deleting asks once first (Sunday can't be shown from them
 * afterwards); the question opens under the button, which says so to VoiceOver. `confirming`: start open (tests).
 */
export function SavedRecordings({ count, onDelete, sharing, siri = false, confirming = false }: {
  count: number; onDelete?: (() => void) | undefined; sharing: boolean; siri?: boolean; confirming?: boolean;
}) {
  const [confirm, setConfirm] = useState(confirming);
  const it = count === 1 ? "it" : "them";
  return <>
    <div className="find-next">
      <span className="bold">{count === 0 ? "No saved checks for this organization." : `${count} saved for this organization.`}</span>
      {count > 0 && onDelete && <button type="button" className="btn btn-forget btn-sm" aria-expanded={confirm} aria-controls="delete-recordings"
        onClick={() => setConfirm(!confirm)}>Delete saved checks</button>}
    </div>
    {count > 0 && onDelete && confirm && <div id="delete-recordings" className="decide" role="group" aria-labelledby="delete-recordings-q">
      <p id="delete-recordings-q" className="find-body">Delete {count === 1 ? "the saved check" : `all ${count} saved checks`} from this Mac? Sunday can't be shown
        from {it} afterwards.{sharing ? " The copy for other AI apps is removed too." : ""}{siri ? " The copy Siri and Shortcuts answer from is removed too." : ""} Planning Center doesn't change.</p>
      <div className="find-next">
        <button type="button" className="btn btn-forget btn-sm" onClick={() => { setConfirm(false); onDelete(); }}>Yes, delete {it}</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirm(false)}>Keep {it}</button>
      </div>
    </div>}
  </>;
}

/**
 * "Your name for notes": the name drafted notes end with, kept on this Mac (connection.ts `yourName`). What the
 * person types stays as typed, so a space between words survives; the saved name is tidied.
 */
export function YourNameField({ store = yourName, optional = false }: { store?: { get(): string; set(name: string): void }; optional?: boolean }) {
  const [typed, setTyped] = useState(() => store.get());
  return <div className="field your-name">
    <label htmlFor="your-name" className="field-l">Your name for notes{optional ? " (optional)" : ""}</label>
    <input id="your-name" className="input" value={typed} maxLength={YOUR_NAME_MAX} autoComplete="name" spellCheck={false} placeholder="[Your name]"
      aria-describedby="your-name-help" onChange={e => { setTyped(e.target.value); store.set(e.target.value); }} />
    <p id="your-name-help" className="input-help">Notes Ozzie drafts end with this name. It stays on this Mac and goes in after any AI rewording, so it's never sent to an AI. Leave it empty to keep [Your name] for you to fill in.</p>
  </div>;
}

/**
 * Settings' sections in the order a leader meets them (audit item 27), each by its heading's id: the short index at the
 * top lists those on the page and moves within the page pane to one.
 */
export const SETTINGS_SECTIONS = [
  { id: "pco-title", label: "Planning Center and which Sunday" },
  { id: "your-name-title", label: "Your name on notes" },
  { id: "ai-title", label: "AI help" },
  { id: "runs-title", label: "What Ozzie runs and notices" },
  { id: "calendars-title", label: "Calendars" },
  { id: "lists-title", label: "Lists and notes" },
  { id: "other-ai-title", label: "Other AI apps, Spotlight and Shortcuts" },
  { id: "updates-title", label: "Updates" },
  { id: "saved-title", label: "Saved checks" },
  { id: "setup-again", label: "Guided setup" },
] as const;

/** "On this page": a link to each section shown; `onGo` moves to it. */
export function SettingsIndex({ sections, onGo }: { sections: readonly { id: string; label: string }[]; onGo?: (id: string) => void }) {
  return <nav className="settings-index" aria-labelledby="settings-index-title">
    <h2 id="settings-index-title" className="eyebrow">On this page</h2>
    <ul>{sections.map(s => <li key={s.id}><a href={`#${s.id}`} onClick={e => { e.preventDefault(); onGo?.(s.id); }}><Icon name="chev" small />{s.label}</a></li>)}</ul>
  </nav>;
}

/** Settings: an index, then Planning Center and which Sunday, your name on notes, AI help, what Ozzie runs and notices, calendars, lists, other AI apps with Spotlight and Shortcuts, updates, saved checks and guided setup, in that order. */
export function ConnectionPage({ status, settings, onSettings, onStatus, recordingCount = 0, onDeleteRecordings, onModel, prefs, onAutomatic, onSetup, onLists, developer, autostart, sharing, siri, oneClick, nameStore, updates, calendars, phone, cards = 0, onDiscardCards }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; onStatus: (s: ConnectionStatus) => void;
  recordingCount?: number; onDeleteRecordings?: () => void; onModel?: (configured: boolean) => void;
  /** The automatic-check schedule, summarized here and changed under What runs automatically. */
  prefs?: ProactivePrefs; onAutomatic?: () => void; onSetup?: () => void;
  /** Opens Lists & notes, where the church's own lists are kept. */
  onLists?: () => void;
  /** "Open Ozzie when I log in" on this Mac; the section is shown only when it's available. */
  autostart?: Autostart | undefined;
  /** Debug builds only: which answering loop Ask Ozzie uses, for comparison. Never shown in a release build. */
  developer?: { loop: "pi" | "ts"; onLoop: (loop: "pi" | "ts") => void } | undefined;
  /** "Use Ozzie's last check in other AI apps" (share-check.ts), off by default; `problem` when turning it on or off failed. */
  sharing?: { on: boolean; onChange: (on: boolean) => void; problem?: string | null } | undefined;
  /** "Let Siri and Shortcuts ask Ozzie" (siri-shortcuts.ts), off by default. */
  siri?: ShortcutsSettings | undefined;
  /** Tests only: whether Ozzie's own registration is built in, instead of asking the app. */
  oneClick?: boolean;
  /** Tests only: where "Your name for notes" is kept, instead of this Mac's storage. */
  nameStore?: { get(): string; set(name: string): void };
  /** New versions of Ozzie (updates-view.tsx `UpdatesSection`), shown after the closed-window section. */
  updates?: ReactNode;
  /** The leader's own calendars (calendar-settings.tsx `CalendarSettings`), shown after What Ozzie runs and notices. */
  calendars?: ReactNode;
  /** Tests only: what stands in for "A notice on your phone" (phone-notice-section.tsx), which otherwise asks native itself. */
  phone?: ReactNode;
  /** Visitor cards open (a count only): switching churches says first that it discards them. */
  cards?: number;
  /** Disconnect was chosen with cards open: App ends them. */
  onDiscardCards?: (() => void) | undefined;
}) {
  const control = useConnectionControl(settings, onStatus, status, oneClick);
  const { canSignIn, working, pending, run } = control;
  // The opt-in signs in again with the same registration (Ozzie's own, or yours under Advanced) as the sign-in form.
  // Check-Ins and Registrations stay as they are when this choice changes.
  const reconnect = (operations: boolean) => { void run(() => control.signIn(operations, moreOf(status)), "operations"); };
  // Each section's place, by its own element (never by looking anything up in the page): its heading, or for Calendars
  // and Updates (sections of their own) the box they sit in. The index lists every section this page can show; once
  // on screen, only those that are (Updates shows only when it has a version to say).
  const page = useRef<HTMLDivElement>(null);
  const places = useRef(new Map<string, HTMLElement>());
  const at = (id: string) => (el: HTMLElement | null) => { if (el) places.current.set(id, el); else places.current.delete(id); };
  const [shown, setShown] = useState<readonly string[] | null>(null);
  const others = Boolean(sharing || siri);
  useLayoutEffect(() => {
    const ids = SETTINGS_SECTIONS.map(s => s.id).filter(id => { const el = places.current.get(id); return el && (el.tagName !== "DIV" || el.childElementCount > 0); });
    setShown(now => now && now.length === ids.length && now.every((id, i) => id === ids[i]) ? now : ids);
  });
  /**
   * Moves to a section: scrolls only the page pane this page sits in so the section is near the top (never
   * scrollIntoView, which scrolls the window too), then gives it keyboard focus without scrolling again.
   */
  const go = (id: string) => {
    const place = places.current.get(id), pane = page.current?.parentElement;
    if (!place) return;
    if (pane) pane.scrollTop += place.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16;
    place.focus({ preventScroll: true });
  };
  const candidates = SETTINGS_SECTIONS.filter(s => (s.id !== "other-ai-title" || others) && (s.id !== "setup-again" || onSetup)
    && (s.id !== "calendars-title" || calendars) && (s.id !== "updates-title" || updates));
  return <div className="col settings" ref={page}>
    <h1 className="h1">Settings</h1>
    <p className="lede">How Ozzie reads your church's Planning Center, and what it keeps on this Mac.</p>
    <SettingsIndex sections={shown ? candidates.filter(s => shown.includes(s.id)) : candidates} onGo={go} />

    <section className="settings-sec" aria-labelledby="pco-title">
      <h2 id="pco-title" className="h3" tabIndex={-1} ref={at("pco-title")}>Planning Center and which Sunday</h2>
      <p className="banner"><Icon name="lock" small /><span><strong>Reads only.</strong> Planning Center may grant broad access at sign-in, but Ozzie has no way to change records or send messages. The connection stays on this Mac, in its Keychain.</span></p>
      <section className="find" aria-labelledby="signin-title">
        <h3 id="signin-title" className="settings-t">Sign in</h3>
        <ConnectForm status={status} settings={settings} onSettings={onSettings} control={control} cards={cards} onDiscardCards={onDiscardCards} />
      </section>
      <section className="find" aria-labelledby="sunday-title">
        <h3 id="sunday-title" className="settings-t">Which Sunday</h3>
        {/* The same picker as guided setup: upcoming plans once connected, with typing the plan by hand folded below. */}
        <SundayPicker connected={status?.state === "connected"} settings={settings} onSettings={onSettings} />
      </section>
      <section className="find" aria-labelledby="operations-title">
        <h3 id="operations-title" className="settings-t">Rooms, follow-ups and group events</h3>
        <p className="find-body">Ozzie can also check room bookings in Planning Center Calendar, follow-ups without an owner in People, and group events at the same time as serving in Groups. Turning this on signs in again and asks Planning Center for Calendar, People and Groups access. Planning Center grants each of those as read-and-write; Ozzie only reads, and has no way to change anything there. People access is also used when you open a note for one person in Mail or Messages: Ozzie then reads that person's email addresses or phone numbers, and whether Planning Center lists them as a child, and uses one only to fill in To.</p>
        <p className="checkline granted">{grantedCopy(status)}</p>
        <div className="row form-actions">
          {!operationsGranted(status)
            ? <button className="btn btn-secondary" disabled={!canSignIn || working || pending} onClick={() => reconnect(true)}>Also check rooms, follow-ups and group events</button>
            : <button className="btn btn-secondary" disabled={!canSignIn || working || pending} onClick={() => reconnect(false)}>Sign in again with Services only</button>}
        </div>
        {control.problem?.from === "operations" && <p role="alert" className="problem">{control.problem.text}</p>}
      </section>
      <MoreFromPlanningCenter status={status} control={control} />
    </section>

    <section className="settings-sec" aria-labelledby="your-name-title">
      <h2 id="your-name-title" className="h3" tabIndex={-1} ref={at("your-name-title")}>Your name on notes</h2>
      <div className="find"><YourNameField {...(nameStore ? { store: nameStore } : {})} /></div>
    </section>

    <section className="settings-sec" aria-labelledby="ai-title">
      <h2 id="ai-title" className="h3" tabIndex={-1} ref={at("ai-title")}>AI help</h2>
      <AiSettings onChange={c => onModel?.(c)} labelledBy="ai-title" />
    </section>

    <section className="settings-sec" aria-labelledby="runs-title">
      <h2 id="runs-title" className="h3" tabIndex={-1} ref={at("runs-title")}>What Ozzie runs and notices</h2>
      <section className="find" aria-labelledby="auto-title">
        <h3 id="auto-title" className="settings-t">Automatic checks</h3>
        {/* Named as everywhere else (audit item 28): the regular Sunday check, and Keep Sunday covered beside it. */}
        <p className="find-body">{prefs ? `The regular Sunday check: ${scheduleLine(prefs).replace(/^./u, c => c.toLowerCase())} Quiet hours ${quietLine(prefs)}` : "The regular Sunday check looks at the chosen Sunday on a schedule while Ozzie is open on this Mac, and tells you privately when something gets worse."}</p>
        <p className="small">Keep Sunday covered and other jobs are set up in What runs automatically.</p>
        {onAutomatic && <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onAutomatic}>Change these in What runs automatically</button></div>}
      </section>
      {autostart && <section className="find" aria-labelledby="background-title">
        <h3 id="background-title" className="settings-t">When the window is closed</h3>
        <p className="find-body">Ozzie keeps running in the menu bar when you close its window, so it can keep an eye on what you asked. To stop it completely, choose Quit Ozzie from the menu bar icon.</p>
        <AutostartToggle autostart={autostart} />
      </section>}
      {phone === undefined ? <PhoneNoticeSection /> : phone}
    </section>

    {calendars && <div className="settings-slot" tabIndex={-1} role="group" aria-labelledby="calendars-title" ref={at("calendars-title")}>{calendars}</div>}

    <section className="settings-sec" aria-labelledby="lists-title">
      <h2 id="lists-title" className="h3" tabIndex={-1} ref={at("lists-title")}>Lists and notes</h2>
      <div className="find">
        <p className="find-body">Your church's own lists and notes have their own page, Lists &amp; notes.</p>
        {onLists && <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onLists}>Open Lists &amp; notes</button></div>}
      </div>
    </section>

    {others && <section className="settings-sec" aria-labelledby="other-ai-title">
      <h2 id="other-ai-title" className="h3" tabIndex={-1} ref={at("other-ai-title")}>Other AI apps, Spotlight and Shortcuts</h2>
      {sharing && <section className="find" aria-labelledby="share-title">
        <h3 id="share-title" className="settings-t">Other AI apps</h3>
        <p className="find-body">{SHARE_BODY}</p>
        <div className="stack-tight">
          <label className="confirmation"><input type="checkbox" checked={sharing.on} onChange={e => sharing.onChange(e.target.checked)} />
            <span>Use Ozzie's last check in other AI apps</span></label>
          <p className="small">Off unless you turn it on. Turning it off removes the copy.</p>
          {sharing.problem && <p role="alert" className="problem">{sharing.problem}</p>}
        </div>
        <OtherAiAppsSetup on={sharing.on} />
        <details className="listen-more">
          <summary>See how this works</summary>
          <ul className="small">{SHARE_HOW.map(line => <li key={line}>{line}</li>)}</ul>
        </details>
      </section>}
      {siri && <SiriShortcutsSection {...siri} />}
    </section>}

    {updates && <div className="settings-slot" tabIndex={-1} role="group" aria-labelledby="updates-title" ref={at("updates-title")}>{updates}</div>}

    <section className="settings-sec" aria-labelledby="saved-title">
      <h2 id="saved-title" className="h3" tabIndex={-1} ref={at("saved-title")}>Saved checks</h2>
      <div className="find">
        <p className="find-body">Each check saves a copy on this Mac, so Sunday can still be shown if Planning Center can't be reached. These saved checks include volunteers' names and stay only on this Mac. Ozzie keeps the five newest for each Sunday.</p>
        <SavedRecordings count={recordingCount} onDelete={onDeleteRecordings} sharing={Boolean(sharing?.on)} siri={Boolean(siri?.on)} />
      </div>
    </section>

    {onSetup && <section className="settings-sec" aria-labelledby="setup-again">
      <h2 id="setup-again" className="h3" tabIndex={-1} ref={at("setup-again")}>Guided setup</h2>
      <div className="find">
        <p className="find-body">Walk through connecting Planning Center, choosing the Sunday, AI help and automatic checks, one step at a time.</p>
        <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onSetup}>Walk through setup again</button></div>
      </div>
    </section>}

    {developer && <section className="settings-sec" aria-labelledby="developer-title">
      <h2 id="developer-title" className="h3">Developer build only</h2>
      <div className="find">
        <p className="find-body">How Ask Ozzie runs its steps, for comparing the two. Both follow the same procedures and checks.</p>
        <div className="row rule-row">
          <label htmlFor="dev-loop">Answering steps</label>
          <select id="dev-loop" className="input" value={developer.loop} onChange={e => developer.onLoop(e.target.value === "ts" ? "ts" : "pi")}>
            <option value="pi">Pi (default)</option><option value="ts">Plain TypeScript</option>
          </select>
        </div>
      </div>
    </section>}
  </div>;
}
