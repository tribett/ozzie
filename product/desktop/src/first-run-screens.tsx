// First run's screens up to the connection (onboarding spec §2: S1, S1b, S2, S3, S4's banner and the Planning Center
// failures). Each screen is one calm decision: a title, a few plain lines, one primary button. They only draw; the shell
// (setup-flow.tsx) decides which one shows from facts (first-run-state.ts) and does the work. Promise sentences come from
// promises.ts only.
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icons.js";
import { allPromises, firstScreenPromises, promise } from "./promises.js";
import type { Failure } from "./first-run-state.js";
import "./first-run.css";

export const FIRST_RUN = {
  /** Before connecting, Ozzie can't know which day the church meets, so nothing here says Sunday (walk-through, 2026-11-18). */
  title: "Ozzie reads your church's Planning Center and tells you what needs you before your next service.",
  connect: "Connect Planning Center",
  example: "See an example church first",
  allPromises: "Read all of Ozzie's promises",
  free: "Free and open source.",
  promisesTitle: "What Ozzie does, and what it never does",
  readsTitle: "Everything Ozzie can read from Planning Center",
  /**
   * Every read Ozzie can make, before any of it happens (review P, L8): what each one is and when. Settings and the People
   * question say the same where each is turned on or first used.
   */
  reads: [
    "For the service Ozzie watches: its times, the roles, who is scheduled and who said yes, each team's members and leaders, the times those people said they'll be away, and the other services they're scheduled for.",
    "Background checks, only if you turn on the kids-team rule: whether each person scheduled on those teams has a current check, never its details.",
    "Email addresses or phone numbers, only when you open a note for one person in Mail or Messages and your connection includes People: that person's, and whether Planning Center lists them as a child. One is used to fill in To. They're kept nowhere and never go to an AI.",
    "A note for one person can then open in this Mac's email app or Messages already addressed to them, when Planning Center has one usable email address or mobile number for them, or marks one as primary.",
    "Only if you turn them on in Settings: room bookings, follow-ups without an owner and group events (Calendar, People and Groups), and Check-Ins and Registrations, as counts only. Allowing People to fill in To doesn't turn any of these on. For the People forms you choose in Church rules: how many new submissions there are, when each was sent and whom it is for, never a form's answers.",
  ],
  backToSetup: "Back to setup",
  browserEyebrow: "Step 1 of 3",
  browserTitle: "Next, allow Ozzie to read your Planning Center",
  /** A church that already saw its result, whose sign-in needs doing again: no step counter (review M8). */
  againTitle: "Connect Planning Center again",
  browserLines: [
    "Your browser will open Planning Center. Sign in as you always do, then choose Allow.",
    "", // promise("connectReads"), filled in at render so the form follows the build
    "Your password stays with Planning Center. Ozzie never sees it, and you can disconnect any time.",
  ],
  open: "Open Planning Center in my browser",
  back: "Back",
  notNow: "Not now",
  tryAgain: "Try again",
  readFold: "What will Ozzie read?",
  readBody: "For the service Ozzie watches: its times, the roles, who is scheduled and who said yes, each team's members and leaders, the times those people said they'll be away, and the other services they're scheduled for. Nothing more unless you ask for it later, and Ozzie asks first.",
  readWording: "Planning Center's page may say Ozzie could also make changes. That's how Planning Center words every connection.",
  offline: "This Mac isn't connected to the internet. Connect to Wi-Fi, then try again.",
  selfBuilt: "For a copy of Ozzie you built yourself",
  pictureAlt: "Ozzie and Planning Center, about to be connected.",
  waitingEyebrow: "Step 2 of 3",
  waitingTitle: "Waiting for you to choose Allow in your browser",
  waitingSteps: ["Sign in to Planning Center if it asks.", "If it asks which church, choose yours.", "Choose Allow. Then come back to Ozzie: it comes to the front, or press Go back to Ozzie on that page."],
  waitingSmall: "Planning Center's page may list more than reading.",
  allowAlt: "A drawing of Planning Center's page asking whether Ozzie for Mac may use your account. The Allow button is at the bottom.",
  openAgain: "Open the page again",
  cancel: "Cancel",
  checking: "Planning Center said yes. Checking which church it is…",
  stillThere: "Still there? Ozzie waits about one more minute, then you can start again.",
  connectedTo: (church: string) => `Connected to ${church}`,
  signedInAs: (church: string, at: string) => `Signed in to Planning Center as part of ${church} · checked ${at}`,
  notMine: "This isn't my church",
  disconnectTitle: (church: string) => `Disconnect ${church}?`,
  disconnectBody: (church: string) => `Ozzie signs out of ${church} in Planning Center. Then, in your browser, choose your own church when Planning Center asks. If it doesn't ask, sign out of Planning Center in your browser first.`,
  disconnectAgain: "Disconnect and try again",
  keep: (church: string) => `Keep ${church}`,
} as const;

/** Keyboard and VoiceOver focus go to a new screen's title (its ring only for the keyboard: `:focus-visible`). */
export function useTitleFocus<T extends HTMLElement>(key: unknown, enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => { if (enabled) ref.current?.focus({ preventScroll: false }); }, [key, enabled]);
  return ref;
}

/**
 * A step's eyebrow and title: the step is read as part of the focused title by VoiceOver ("Step 2 of 3: …") and the
 * visible eyebrow isn't read twice (review L10). No step: the title alone.
 */
export function StepHead({ step, titleRef, children }: { step: string | null; titleRef: React.RefObject<HTMLHeadingElement | null>; children: ReactNode }) {
  return <>
    {step && <p className="eyebrow" aria-hidden="true">{step}</p>}
    <h1 id="fr-title" className={`fr-title${step ? " fr-title-step" : ""}`} tabIndex={-1} ref={titleRef}>{step && <span className="sr-only">{step}: </span>}{children}</h1>
  </>;
}

/** A sheet over the page: Escape or its own button closes it; focus starts on its title and returns where it was. */
export function Sheet({ title, onClose, children, labelId }: { title: string; onClose: () => void; children: ReactNode; labelId: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const before = typeof document === "undefined" ? null : document.activeElement as HTMLElement | null;
    heading.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); before?.focus?.(); };
  }, [onClose]);
  return <div className="fr-sheet-back" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="fr-sheet" role="dialog" aria-modal="true" aria-labelledby={labelId}>
      <h2 id={labelId} className="fr-sheet-title" tabIndex={-1} ref={heading}>{title}</h2>
      {children}
    </div>
  </div>;
}

const Checks = ({ lines }: { lines: readonly string[] }) =>
  <ul className="fr-checks">{lines.map(line => <li key={line}><Icon name="check" small /><span>{line}</span></li>)}</ul>;

/** S1: one sentence, three promises, one button, and a quiet way to look first. */
export function FirstScreen({ onConnect, onExample, onPromises }: { onConnect: () => void; onExample: () => void; onPromises: () => void }) {
  const title = useTitleFocus<HTMLHeadingElement>("first");
  return <section className="fr" aria-labelledby="fr-title">
    <h1 id="fr-title" className="fr-title" tabIndex={-1} ref={title}>{FIRST_RUN.title}</h1>
    <Checks lines={firstScreenPromises()} />
    <div className="fr-actions">
      <button type="button" className="btn btn-primary fr-primary" onClick={onConnect}>{FIRST_RUN.connect}</button>
      <button type="button" className="fr-link" onClick={onExample}>{FIRST_RUN.example}</button>
      <button type="button" className="fr-link" onClick={onPromises}>{FIRST_RUN.allPromises}</button>
    </div>
    <p className="fr-small">{FIRST_RUN.free}</p>
  </section>;
}

/** S1b: every promise, one tap from the first screen. */
export function PromisesSheet({ onClose }: { onClose: () => void }) {
  return <Sheet title={FIRST_RUN.promisesTitle} onClose={onClose} labelId="fr-promises-title">
    <Checks lines={allPromises()} />
    <h3 className="fr-h2">{FIRST_RUN.readsTitle}</h3>
    <ul className="fr-reads">{FIRST_RUN.reads.map(line => <li key={line}>{line}</li>)}</ul>
    <div className="fr-actions"><button type="button" className="btn btn-primary fr-primary" onClick={onClose}>{FIRST_RUN.backToSetup}</button></div>
  </Sheet>;
}

/** Ozzie's mark, a link line, and Planning Center's name in text (its mark only if its brand rules allow: spec §11.8). */
function ConnectPicture() {
  return <div className="fr-picture" role="img" aria-label={FIRST_RUN.pictureAlt}>
    <span className="fr-tile"><img src="/ozzie.svg" alt="" /></span>
    <span className="fr-line" aria-hidden="true"><Icon name="link" small /></span>
    <span className="fr-tile fr-tile-text" aria-hidden="true">Planning Center</span>
  </div>;
}

/** A Planning Center outcome, in its fixed sentence, with its buttons (spec rows 1–13). */
export function FailurePanel({ failure, onTryAgain, onNotNow }: { failure: Failure; onTryAgain: () => void; onNotNow: () => void }) {
  if (!failure.alert) return <p className="fr-note" role="status">{failure.text}</p>;
  return <div className="fr-failure" role="alert">
    <p>{failure.text}</p>
    <div className="fr-row">
      <button type="button" className="btn btn-primary" onClick={onTryAgain}>{FIRST_RUN.tryAgain}</button>
      {failure.notNow && <button type="button" className="fr-link" onClick={onNotNow}>{FIRST_RUN.notNow}</button>}
    </div>
  </div>;
}

/**
 * S2, before the browser: two marks, three reassurances, one button. A failure or the resume line sits above the
 * button; offline, the button waits for the internet. `selfBuilt`: a copy with no built-in registration shows its own
 * form instead of the button.
 */
export function BrowserStep({ failure, resume, offline, working, onOpen, onBack, onNotNow, selfBuilt, again = false }: {
  failure: Failure | null; resume: string | null; offline: boolean; working: boolean;
  /** A church that already saw a result: "Connect Planning Center again", no step counter. */
  again?: boolean;
  onOpen: () => void; onBack: () => void; onNotNow: () => void; selfBuilt?: ReactNode;
}) {
  const title = useTitleFocus<HTMLHeadingElement>("browser");
  const lines = FIRST_RUN.browserLines.map((l, i) => i === 1 ? promise("connectReads") : l);
  return <section className="fr" aria-labelledby="fr-title">
    {!again && <ConnectPicture />}
    <StepHead step={again ? null : FIRST_RUN.browserEyebrow} titleRef={title}>{again ? FIRST_RUN.againTitle : FIRST_RUN.browserTitle}</StepHead>
    <Checks lines={lines} />
    {failure && <FailurePanel failure={failure} onTryAgain={onOpen} onNotNow={onNotNow} />}
    {!failure && resume && <p className="fr-note" role="status">{resume}</p>}
    {offline && <p className="fr-note" role="status">{FIRST_RUN.offline}</p>}
    {selfBuilt
      ? <section className="fr-self" aria-labelledby="fr-self-title"><h2 id="fr-self-title" className="fr-h2">{FIRST_RUN.selfBuilt}</h2>{selfBuilt}</section>
      : <div className="fr-actions">
        {(!failure || !failure.alert) && <button type="button" className="btn btn-primary fr-primary" disabled={offline || working} onClick={onOpen}>{FIRST_RUN.open}</button>}
        <button type="button" className="fr-link" onClick={onBack}>{FIRST_RUN.back}</button>
      </div>}
    <details className="fr-fold">
      <summary><Icon name="chev" small />{FIRST_RUN.readFold}</summary>
      <p>{FIRST_RUN.readBody}</p>
      <p>{FIRST_RUN.readWording} {promise("still")}</p>
    </details>
  </section>;
}

/** A drawing of Planning Center's Allow page (not the real page: the clean-Mac capture isn't in the repo yet). */
function AllowPicture() {
  return <svg className="fr-allow" viewBox="0 0 320 180" role="img" aria-label={FIRST_RUN.allowAlt}>
    <rect x="1" y="1" width="318" height="178" rx="12" className="fr-allow-page" />
    <rect x="1" y="1" width="318" height="26" rx="12" className="fr-allow-bar" />
    <circle cx="18" cy="14" r="4" className="fr-allow-dot" /><circle cx="32" cy="14" r="4" className="fr-allow-dot" /><circle cx="46" cy="14" r="4" className="fr-allow-dot" />
    <text x="160" y="58" textAnchor="middle" className="fr-allow-h">Ozzie for Mac</text>
    <text x="160" y="80" textAnchor="middle" className="fr-allow-t">would like to use your Planning Center account</text>
    <rect x="70" y="96" width="180" height="8" rx="4" className="fr-allow-lines" />
    <rect x="90" y="110" width="140" height="8" rx="4" className="fr-allow-lines" />
    <rect x="118" y="134" width="84" height="30" rx="8" className="fr-allow-btn" />
    <text x="160" y="154" textAnchor="middle" className="fr-allow-btn-t">Allow</text>
    <ellipse cx="160" cy="149" rx="58" ry="24" className="fr-allow-ring" />
  </svg>;
}

/** S3, while Planning Center waits for Allow: what to do there, a new attempt for a closed tab, and Cancel. */
export function WaitingStep({ checking, slow, working, onAgain, onCancel }: {
  checking: boolean; slow: boolean; working: boolean; onAgain: () => void; onCancel: () => void;
}) {
  const title = useTitleFocus<HTMLHeadingElement>("waiting");
  return <section className="fr" aria-labelledby="fr-title">
    <StepHead step={FIRST_RUN.waitingEyebrow} titleRef={title}>{FIRST_RUN.waitingTitle}</StepHead>
    <AllowPicture />
    <ol className="fr-steps">{FIRST_RUN.waitingSteps.map(s => <li key={s}>{s}</li>)}</ol>
    <p className="fr-note" aria-live="polite">{checking ? FIRST_RUN.checking : slow ? FIRST_RUN.stillThere : ""}</p>
    <p className="fr-small">{FIRST_RUN.waitingSmall} {promise("still")}</p>
    <div className="fr-actions">
      <button type="button" className="btn btn-secondary" disabled={working || checking} onClick={onAgain}>{FIRST_RUN.openAgain}</button>
      <button type="button" className="fr-link" disabled={working} onClick={onCancel}>{FIRST_RUN.cancel}</button>
    </div>
  </section>;
}

/** S4, back from the browser: which church Ozzie connected to, when it checked, and a way out if it's the wrong one. */
export function ConnectedBanner({ church, checkedAt, onNotMine }: { church: string; checkedAt: string | null; onNotMine: () => void }) {
  return <div className="fr-connected" role="status">
    <Icon name="check" />
    <div>
      <p className="fr-connected-t">{FIRST_RUN.connectedTo(church)}</p>
      {checkedAt && <p className="fr-small">{FIRST_RUN.signedInAs(church, checkedAt)}</p>}
    </div>
    <button type="button" className="fr-link" onClick={onNotMine}>{FIRST_RUN.notMine}</button>
  </div>;
}

/** Row 6: the wrong church. Disconnecting signs Ozzie out; then the person signs in to their own church. */
export function NotMyChurchSheet({ church, working, onDisconnect, onKeep }: { church: string; working: boolean; onDisconnect: () => void; onKeep: () => void }) {
  return <Sheet title={FIRST_RUN.disconnectTitle(church)} onClose={onKeep} labelId="fr-not-mine-title">
    <p>{FIRST_RUN.disconnectBody(church)}</p>
    <div className="fr-actions">
      <button type="button" className="btn btn-primary fr-primary" disabled={working} onClick={onDisconnect}>{FIRST_RUN.disconnectAgain}</button>
      <button type="button" className="fr-link" onClick={onKeep}>{FIRST_RUN.keep(church)}</button>
    </div>
  </Sheet>;
}
