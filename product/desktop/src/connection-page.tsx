import { OtherAiAppsSetup } from "./other-ai-apps-setup.js";
import { PhoneNoticeSection } from "./phone-notice-section.js";
import { SiriShortcutsSection } from "./siri-shortcuts-section.js";
import type { ShortcutsSettings } from "./siri-shortcuts.js";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { moreOf, operationsGranted, yourName, YOUR_NAME_MAX, type ConnectionStatus } from "./connection.js";
import { askForOperations, useOperationsReads } from "./operations-reads.js";
import { MORE_LOST } from "./read-more.js";
import { CARD_NAMES_READ } from "./people-question.js";
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
import { eyeLine, genesisNoJobs, keepTitle, SERVICES, Services } from "./day-phrases.js";
import { promise } from "./promises.js";
import { useSystemWords } from "./church-system.js";
import { TEXT_SIZE_NOTE } from "./text-size.js";

/** How Planning Center words a connection at sign-in (spec §6), said beside the promise. */
export const CONNECTION_WORDING = "Planning Center's page may say Ozzie could also make changes. That's how Planning Center words every connection.";
/** Where the connection is kept, only inside "See how this works" (spec §6: "Keychain" nowhere else). */
export const CONNECTION_HOW = "The connection is kept in this Mac's Keychain, where macOS keeps passwords. Ozzie uses it to read your church's Planning Center and, only if you turn on adding people, to make the one change you confirm. Disconnecting removes it.";
/** "When the window is closed": the menu bar named for someone who has never heard the words (spec §6), then by name. */
export const CLOSED_WINDOW = "Ozzie keeps running when you close its window, as the small Ozzie picture at the top of your screen, so it can keep an eye on what you asked. To stop it completely, click that picture in the menu bar and choose Quit Ozzie.";
/** Where Settings' switch for rooms, follow-ups and group events is set, once the access is granted (operations-reads.ts). */
export { setOperationsReadsAfter } from "./operations-reads.js";
/** Check my setup (spec §4.3), in place of Guided setup. */
export const CHECK_SETUP_BODY = "See at a glance whether Planning Center, the service Ozzie watches, AI, notices and starting with this Mac are working, with one button to fix anything that isn't.";

/**
 * The access the saved connection was granted, known only once it's been checked this session, and whether rooms,
 * follow-ups and group events are read: native's own switch (`readsOn`), never the granted access alone.
 */
export function grantedCopy(status: ConnectionStatus | null, readsOn: boolean | null = null): string {
  if (operationsGranted(status)) {
    return readsOn === true ? "Granted: Services, Calendar, People and Groups. Ozzie reads rooms, follow-ups and group events."
      : readsOn === false ? "Granted: Services, Calendar, People and Groups. Rooms, follow-ups and group events are off until you turn them on here."
        : "Granted: Services, Calendar, People and Groups.";
  }
  // Turned on, but the last sign-in didn't include the access (review 2026-11-18, late): said, not left as "aren't checked".
  if (status?.scopes) return readsOn === true ? `Granted: Services only. ${MORE_LOST}` : "Granted: Services only. Rooms, follow-ups and group events aren't checked.";
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
  const w = useSystemWords();
  const it = count === 1 ? "it" : "them";
  return <>
    <div className="find-next">
      <span className="bold">{count === 0 ? "No saved checks for this church." : `${count} saved for this church.`}</span>
      {count > 0 && onDelete && <button type="button" className="btn btn-forget btn-sm" aria-expanded={confirm} aria-controls="delete-recordings"
        onClick={() => setConfirm(!confirm)}>Delete saved checks</button>}
    </div>
    {count > 0 && onDelete && confirm && <div id="delete-recordings" className="decide" role="group" aria-labelledby="delete-recordings-q">
      <p id="delete-recordings-q" className="find-body">Delete {count === 1 ? "the saved check" : `all ${count} saved checks`} from this Mac? {Services} can't be shown
        from {it} afterwards.{sharing ? " The copy for other AI apps is removed too." : ""}{siri ? " The copy Siri and Shortcuts answer from is removed too." : ""} {w.name} doesn't change.</p>
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
/**
 * After Settings opens at a section, when it is put back in place if the sections above it grew as they finished
 * reading (review L6): on the next frame, then at these times, and never after the last. Bounded, and it stops as soon
 * as the person scrolls the page themselves.
 */
export const OPEN_AT_SETTLE_MS = [100, 300, 700, 1_500] as const;

export const SETTINGS_SECTIONS = [
  { id: "pco-title", label: "Planning Center and which services Ozzie watches" },
  { id: "systems-title", label: "Other church systems" },
  { id: "your-name-title", label: "Your name on notes" },
  { id: "ai-title", label: "AI help" },
  { id: "runs-title", label: "What Ozzie runs and notices" },
  { id: "calendars-title", label: "Calendars" },
  { id: "lists-title", label: "Church lists" },
  { id: "other-ai-title", label: "Other AI apps, Spotlight and Shortcuts" },
  { id: "updates-title", label: "Updates" },
  { id: "saved-title", label: "Saved checks" },
  { id: "check-setup", label: "Check my setup" },
] as const;

/** "On this page": a link to each section shown; `onGo` moves to it. */
export function SettingsIndex({ sections, onGo }: { sections: readonly { id: string; label: string }[]; onGo?: (id: string) => void }) {
  return <nav className="settings-index" aria-labelledby="settings-index-title">
    <h2 id="settings-index-title" className="eyebrow">On this page</h2>
    <ul>{sections.map(s => <li key={s.id}><a href={`#${s.id}`} onClick={e => { e.preventDefault(); onGo?.(s.id); }}><Icon name="chev" small />{s.label}</a></li>)}</ul>
  </nav>;
}

/**
 * Settings: an index, then Planning Center and which service Ozzie watches, your name on notes, AI help, what Ozzie runs
 * and notices, calendars, lists, other AI apps with Spotlight and Shortcuts, updates, saved checks and Check my setup, in
 * that order.
 */
export function ConnectionPage({ system, others, watched, status, kept = null, settings, onSettings, onStatus, recordingCount = 0, onDeleteRecordings, onModel, onAiAnswer, prefs, onAutomatic, onSetup, onCheckSetup, onLists, developer, autostart, sharing, siri, oneClick, nameStore, updates, calendars, phone, cards = 0, onDiscardCards, operationsReads: readsProp, openAt, onOpenAt,
  changes, onDisconnectTried, onPlanService }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; onStatus: (s: ConnectionStatus) => void;
  /** The plan picked in the picker, with its service's Planning Center name, so App can name that service on screen. */
  onPlanService?: ((planId: string, name: string | null) => void) | undefined;
  /** A church on B1 Church or Breeze: its own section (system-settings.tsx), in place of Planning Center's. */
  system?: ReactNode;
  /** Every church's way to the other church systems: switching, and Genesis read beside (system-settings.tsx). */
  others?: ReactNode;
  /** The other services Ozzie watches, and "Watch another service" (watch-another.tsx), under the first one's picker. */
  watched?: ReactNode;
  /**
   * The church's last confirmed connection while a sign-in for that church is under way, or after one ended with it back
   * in use (App): Settings keep saying it is connected and keep its plans (review item 7). Null otherwise.
   */
  kept?: ConnectionStatus | null;
  recordingCount?: number; onDeleteRecordings?: () => void; onModel?: (configured: boolean) => void;
  /** A way chosen, or No AI for now, in AI help (ai-settings.tsx `onAnswer`): App keeps it as setup's AI answer. */
  onAiAnswer?: ((how: "chosen" | "none") => void) | undefined;
  /** Ozzie's hourly look at the watched service, summarized here and changed under Keeping watch. */
  prefs?: ProactivePrefs; onAutomatic?: () => void;
  /** "Walk through setup again": the guided setup, kept beside Check my setup (owner's choice). */
  onSetup?: () => void;
  /** "Check my setup" (spec §4.3): opens the checklist. The section shows when either this or `onSetup` is given. */
  onCheckSetup?: () => void;
  /** Opens Church lists, where the church's own lists are kept. */
  onLists?: () => void;
  /** "Start Ozzie when this Mac starts"; the section is shown only when it's available. */
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
  /** Tests only: whether the rooms, follow-ups and group reads are on, instead of asking native. */
  operationsReads?: boolean | null;
  /**
   * Opens at this section (its heading's id: AI help after the AI screens were open over Settings, or any section chosen
   * in Find), then `onOpenAt`.
   */
  openAt?: string | null;
  onOpenAt?: () => void;
  /**
   * "Let Ozzie make changes you confirm" (change-card.tsx `ChangesSwitch`), and the line about reading as it reads while
   * that is on (`banner`): App passes it only while Planning Center is connected, the banner only while the switch is on.
   */
  changes?: { section: ReactNode; banner: { strong: string; rest: string } | null } | undefined;
  /** A Disconnect was tried, however it ended (planning-center-forms.tsx `ConnectForm`). */
  onDisconnectTried?: (() => void) | undefined;
}) {
  const w = useSystemWords();
  const control = useConnectionControl(settings, onStatus, status, oneClick);
  const { canSignIn, working, pending, run } = control;
  // The opt-in signs in again with the same registration (Ozzie's own, or yours under Advanced) as the sign-in form.
  // Check-Ins and Registrations stay as they are when this choice changes.
  // Rooms, follow-ups and group events are read only while native's switch is on (first-run review H1). Native keeps the
  // switch per church, read again whenever the church in use changes; the offer after the first check (read-more.tsx)
  // shares it and this sign-in (operations-reads.ts).
  const reads = useOperationsReads(status, { read: readsProp === undefined });
  const readsOn = readsProp !== undefined ? readsProp : reads.on;
  const switchReads = (on: boolean) => { void reads.switchReads(on).catch(() => undefined); };
  // A sign-in asked for the access: the switch goes on once Planning Center granted it, not before.
  const reconnect = (operations: boolean) => {
    if (operations) { void askForOperations(control, status); return; }
    switchReads(false);
    void run(() => control.signIn(false, moreOf(status)), "operations");
  };
  // Each section's place, by its own element (never by looking anything up in the page): its heading, or for Calendars
  // and Updates (sections of their own) the box they sit in. The index lists every section this page can show; once
  // on screen, only those that are (Updates shows only when it has a version to say).
  const page = useRef<HTMLDivElement>(null);
  const places = useRef(new Map<string, HTMLElement>());
  const at = (id: string) => (el: HTMLElement | null) => { if (el) places.current.set(id, el); else places.current.delete(id); };
  const [shown, setShown] = useState<readonly string[] | null>(null);
  const shares = Boolean(sharing || siri);
  useLayoutEffect(() => {
    const ids = SETTINGS_SECTIONS.map(s => s.id).filter(id => { const el = places.current.get(id); return el && (el.tagName !== "DIV" || el.childElementCount > 0); });
    setShown(now => now && now.length === ids.length && now.every((id, i) => id === ids[i]) ? now : ids);
  });
  /**
   * Moves to a section: scrolls only the page pane this page sits in so the section is near the top (never
   * scrollIntoView, which scrolls the window too), then gives it keyboard focus without scrolling again.
   */
  const align = (id: string) => {
    const place = places.current.get(id), pane = page.current?.parentElement;
    if (place && pane) pane.scrollTop += place.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16;
    return place;
  };
  const go = (id: string) => align(id)?.focus({ preventScroll: true });
  // Opened at a section: the sections above it may still grow as they finish reading, so it is put back in place for a
  // moment (OPEN_AT_SETTLE_MS), until the person scrolls the page themselves (review L6).
  const settling = useRef<() => void>(() => {});
  useEffect(() => () => settling.current(), []);
  useLayoutEffect(() => {
    if (!openAt) return;
    go(openAt);
    onOpenAt?.();
    settling.current();
    const pane = page.current?.parentElement;
    if (!pane) return;
    let last = pane.scrollTop;
    const timers = OPEN_AT_SETTLE_MS.map(ms => setTimeout(() => again(), ms));
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => again()) : null;
    const stop = () => { timers.forEach(clearTimeout); if (frame !== null) cancelAnimationFrame(frame); };
    const again = () => {
      if (pane.scrollTop !== last) { stop(); return; }
      align(openAt);
      last = pane.scrollTop;
    };
    settling.current = stop;
  }, [openAt]);
  const candidates = SETTINGS_SECTIONS.filter(s => (s.id !== "other-ai-title" || shares) && (s.id !== "check-setup" || onSetup || onCheckSetup)
    && (s.id !== "calendars-title" || calendars) && (s.id !== "updates-title" || updates) && (s.id !== "systems-title" || others))
    // The church's own system names its section.
    .map(s => s.id === "pco-title" && system ? { ...s, label: `${w.name} and which service Ozzie watches` } : s);
  return <div className="col settings" ref={page}>
    {/* Headed like every other page: the sidebar's name small above, then a title that says something (polish pass). */}
    <p className="eyebrow">Settings</p>
    <h1 className="h1">How Ozzie is set up on this Mac</h1>
    <p className="lede">Which church and service Ozzie reads, how it uses AI and tells you things, and what it keeps here.</p>
    {/* Text size (accessibility audit B1): where the View menu's Bigger Text is, said where people look for it. */}
    <p className="small text-size-note">{TEXT_SIZE_NOTE}</p>
    <SettingsIndex sections={shown ? candidates.filter(s => shown.includes(s.id)) : candidates} onGo={go} />

    {system ? <div className="settings-slot" tabIndex={-1} role="group" aria-labelledby="pco-title" ref={at("pco-title")}>{system}</div>
    : <section className="settings-sec" aria-labelledby="pco-title">
      <h2 id="pco-title" className="h3" tabIndex={-1} ref={at("pco-title")}>Planning Center and which services Ozzie watches</h2>
      <div className="banner"><Icon name="lock" small /><div className="stack-tight">
        {changes?.banner
          ? <span><strong>{changes.banner.strong}</strong> {changes.banner.rest}</span>
          : <span><strong>{promise("readsShort")}</strong> {CONNECTION_WORDING} {promise("still")} The connection is kept safely on this Mac.</span>}
        <details className="listen-more">
          <summary><Icon name="chev" small />See how this works</summary>
          <p className="small">{CONNECTION_HOW}</p>
        </details>
      </div></div>
      <section className="find" aria-labelledby="signin-title">
        <h3 id="signin-title" className="settings-t">Sign in</h3>
        <ConnectForm status={status} kept={kept} settings={settings} onSettings={onSettings} control={control} cards={cards} onDiscardCards={onDiscardCards} onDisconnectTried={onDisconnectTried} />
      </section>
      <section className="find" aria-labelledby="sunday-title">
        <h3 id="sunday-title" className="settings-t">Which services Ozzie watches</h3>
        {/* The same picker as guided setup: upcoming plans once connected, with typing the plan by hand folded below. */}
        <SundayPicker connected={status?.state === "connected" || Boolean(kept)} waiting={pending} settings={settings} onSettings={onSettings} onService={onPlanService} />
        {watched}
      </section>
      {changes?.section}
      <section className="find" aria-labelledby="operations-title">
        <h3 id="operations-title" className="settings-t">Rooms, follow-ups and group events</h3>
        <p className="find-body">Ozzie can also check room bookings in Planning Center Calendar, follow-ups without an owner in People, and group events at the same time as serving in Groups. {operationsGranted(status)
          ? "Your connection already includes Calendar, People and Groups, so turning this on needs no new sign-in."
          : "Turning this on signs in again and asks Planning Center for Calendar, People and Groups access."} Planning Center grants each of those as read-and-write; Ozzie only reads Calendar, People and Groups, and has no way to change anything in them. People access is also used when you open a note for one person in Mail or Messages: Ozzie then reads that person's email addresses or phone numbers, and whether Planning Center lists them as a child, and uses one only to fill in To. {CARD_NAMES_READ}</p>
        <p className="checkline granted">{grantedCopy(status, readsOn)}</p>
        <div className="row form-actions">
          {!operationsGranted(status)
            ? <button className="btn btn-secondary" disabled={!canSignIn || working || pending} onClick={() => reconnect(true)}>Also check rooms, follow-ups and group events</button>
            : readsOn === false
              // People is held (allowed for a note's To line or the visitor cards): dropping it is here too, as the
              // cards page's notice says (privacy review L5).
              ? <>
                <button className="btn btn-secondary" disabled={working} onClick={() => switchReads(true)}>Also check rooms, follow-ups and group events</button>
                <button className="btn btn-quiet" disabled={!canSignIn || working || pending} onClick={() => reconnect(false)}>Connect again with Services only</button>
              </>
              : <>
                {readsOn === true && <button className="btn btn-secondary" disabled={working} onClick={() => switchReads(false)}>Turn off rooms, follow-ups and group events</button>}
                <button className="btn btn-quiet" disabled={!canSignIn || working || pending} onClick={() => reconnect(false)}>Connect again with Services only</button>
              </>}
        </div>
        {control.problem?.from === "operations" && <p role="alert" className="problem">{control.problem.text}</p>}
      </section>
      <MoreFromPlanningCenter status={status} control={control} />
    </section>}
    {others && <div className="settings-slot" tabIndex={-1} role="group" aria-labelledby="systems-title" ref={at("systems-title")}>{others}</div>}

    <section className="settings-sec" aria-labelledby="your-name-title">
      <h2 id="your-name-title" className="h3" tabIndex={-1} ref={at("your-name-title")}>Your name on notes</h2>
      <div className="find"><YourNameField {...(nameStore ? { store: nameStore } : {})} /></div>
    </section>

    <section className="settings-sec" aria-labelledby="ai-title">
      <h2 id="ai-title" className="h3" tabIndex={-1} ref={at("ai-title")}>AI help</h2>
      <AiSettings onChange={c => onModel?.(c)} onAnswer={onAiAnswer} labelledBy="ai-title" />
    </section>

    <section className="settings-sec" aria-labelledby="runs-title">
      <h2 id="runs-title" className="h3" tabIndex={-1} ref={at("runs-title")}>What Ozzie runs and notices</h2>
      <section className="find" aria-labelledby="auto-title">
        <h3 id="auto-title" className="settings-t">Keeping watch</h3>
        {/* Named as everywhere else (spec §6): Ozzie keeps an eye on your services, and the job beside it. */}
        <p className="find-body">{!w.checksOnItsOwn ? `Ozzie reads ${SERVICES} from ${w.name} when Ozzie starts, and when you press ${w.checkNow}. Checking on a schedule, and its notices, work with Planning Center only for now.`
          // Genesis has no services to check: what runs is Ozzie's own read of it.
          : prefs ? `${w.system === "genesis" ? "Ozzie reads Genesis on its own" : eyeLine()}: ${scheduleLine(prefs).replace(/^./u, c => c.toLowerCase())} Quiet hours ${quietLine(prefs)}`
          : w.system === "genesis" ? "Ozzie reads Genesis on its own while it is open on this Mac, and says on Today when a form has been filled in again."
          : `${eyeLine()} on a schedule while Ozzie is open on this Mac, and tells you privately when something gets worse.`}</p>
        {w.jobs ? <p className="small">{keepTitle()} and other jobs are set up in Keeping watch.</p>
          // Only Genesis has no jobs: they work with Planning Center, B1 Church and Breeze (0.8.0).
          : <p className="small">{genesisNoJobs()}</p>}
        {onAutomatic && <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onAutomatic}>Change these in Keeping watch</button></div>}
      </section>
      {autostart && <section className="find" aria-labelledby="background-title">
        <h3 id="background-title" className="settings-t">When the window is closed</h3>
        <p className="find-body">{CLOSED_WINDOW}</p>
        <AutostartToggle autostart={autostart} />
      </section>}
      {phone === undefined ? <PhoneNoticeSection /> : phone}
    </section>

    {calendars && <div className="settings-slot" tabIndex={-1} role="group" aria-labelledby="calendars-title" ref={at("calendars-title")}>{calendars}</div>}

    <section className="settings-sec" aria-labelledby="lists-title">
      <h2 id="lists-title" className="h3" tabIndex={-1} ref={at("lists-title")}>Church lists</h2>
      <div className="find">
        <p className="find-body">Your church's own lists and notes have their own page, Church lists.</p>
        {onLists && <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onLists}>Open Church lists</button></div>}
      </div>
    </section>

    {shares && <section className="settings-sec" aria-labelledby="other-ai-title">
      <h2 id="other-ai-title" className="h3" tabIndex={-1} ref={at("other-ai-title")}>Other AI apps, Spotlight and Shortcuts</h2>
      {!w.askAndShare && <p className="find-body">{w.notHere("Sharing Ozzie's last check with other AI apps, Spotlight and Shortcuts")}</p>}
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
          <summary><Icon name="chev" small />See how this works</summary>
          <ul className="small">{SHARE_HOW.map(line => <li key={line}>{line}</li>)}</ul>
        </details>
      </section>}
      {siri && <SiriShortcutsSection {...siri} />}
    </section>}

    {updates && <div className="settings-slot" tabIndex={-1} role="group" aria-labelledby="updates-title" ref={at("updates-title")}>{updates}</div>}

    <section className="settings-sec" aria-labelledby="saved-title">
      <h2 id="saved-title" className="h3" tabIndex={-1} ref={at("saved-title")}>Saved checks</h2>
      <div className="find">
        <p className="find-body">{w.savedChecks ? `Each check saves a copy on this Mac, so ${SERVICES} can still be shown if ${w.name} can't be reached. These saved checks include volunteers' names and stay only on this Mac. Ozzie keeps the five newest for each service.`
          : `Ozzie doesn't save copies of ${w.name} checks: each one stays only while Ozzie is open. Any saved checks below are from Planning Center.`}</p>
        <SavedRecordings count={recordingCount} onDelete={onDeleteRecordings} sharing={Boolean(sharing?.on)} siri={Boolean(siri?.on)} />
      </div>
    </section>

    {(onCheckSetup || onSetup) && <section className="settings-sec" aria-labelledby="check-setup">
      <h2 id="check-setup" className="h3" tabIndex={-1} ref={at("check-setup")}>Check my setup</h2>
      <div className="find">
        {/* The church's own system; neutral before one is chosen (polish 2026-11-21). */}
        <p className="find-body">{w.say(CHECK_SETUP_BODY)}</p>
        <div className="find-next">
          {onCheckSetup && <button type="button" className="btn btn-secondary btn-sm" onClick={onCheckSetup}>Check my setup</button>}
          {onSetup && <button type="button" className="btn btn-quiet btn-sm" onClick={onSetup}>Walk through setup again</button>}
        </div>
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
