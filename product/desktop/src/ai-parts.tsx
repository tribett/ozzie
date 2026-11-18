// The pieces every AI screen is made of (onboarding spec §0.1, §3), shared by first run and Settings so the two can't
// differ: a screen with its title focused, a sheet that Escape closes, a quiet link, a success line, an error panel with
// "Check my setup", and the "What the AI sees" sheet built from the real request for the fictional example church.
import { createContext, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import { Icon } from "./icons.js";
import { AI } from "./ai-words.js";
import type { OnboardingBridge } from "./onboarding-bridge.js";
import { buildRewordRequest, templateDraft } from "../../../core/src/draft-request.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import "./ai-screens.css";

/** What every AI screen needs from where it is shown. `focus`: move focus to each screen's title (not on a page load). */
export interface AiPlace { bridge: OnboardingBridge; mode: "first-run" | "settings"; onCheckSetup?: (() => void) | undefined; focus: boolean }
export const AiPlaceContext = createContext<AiPlace | null>(null);
export function useAiPlace(): AiPlace {
  const place = useContext(AiPlaceContext);
  if (!place) throw new Error("An AI screen is shown only inside AiChoice or AiSettings.");
  return place;
}

/** One AI screen: an optional eyebrow, the title (focused when the screen opens; its ring only for the keyboard), the rest. */
export function Screen({ eyebrow, title, children }: { eyebrow?: string | undefined; title: string; children: ReactNode }) {
  const { mode, focus } = useAiPlace();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focus) heading.current?.focus(); }, [focus]);
  const H = mode === "settings" ? "h3" : "h2";
  return <section className={`ai${mode === "first-run" ? " ai-first" : ""}`} aria-labelledby={id}>
    <div className="ai-head">
      {eyebrow && <p className="ai-eyebrow">{eyebrow}</p>}
      <H id={id} className="ai-title" tabIndex={-1} ref={heading}>{title}</H>
    </div>
    {children}
  </section>;
}

/** A sheet over the window. Escape (from anywhere inside it) or its own button closes it; focus starts on its title. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const before = typeof document === "undefined" ? null : document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => { before?.focus?.(); };
  }, []);
  return <div className="ai-sheet-back">
    <div className="ai-sheet" role="dialog" aria-modal="true" aria-labelledby={id}
      onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <h2 id={id} className="ai-sheet-title" tabIndex={-1} ref={heading}>{title}</h2>
      {children}
    </div>
  </div>;
}

/** A quiet link: words only, with a 44px target. */
export const Quiet = ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) =>
  <button type="button" className="ai-link" onClick={onClick} disabled={disabled}>{children}</button>;

/** A line that says what is happening now, read out politely. Empty: nothing is said. */
export const Status = ({ text }: { text: string }) => <p className="ai-status" role="status" aria-live="polite">{text}</p>;

/** What worked, with a check mark. */
export const Ok = ({ lines }: { lines: readonly string[] }) =>
  <div className="ai-ok" role="status" aria-live="polite"><Icon name="check" small /><div>{lines.map(l => <p key={l}>{l}</p>)}</div></div>;

/** What didn't work and what to try, with its buttons, then a quiet "Check my setup" when the page offers one. */
export function Problem({ text, children, calm = false }: { text: string; children?: ReactNode; calm?: boolean }) {
  const { onCheckSetup } = useAiPlace();
  return <div className="ai-problem" role={calm ? "status" : "alert"}>
    <p>{text}</p>
    {children && <div className="ai-actions">{children}</div>}
    {!calm && onCheckSetup && <Quiet onClick={onCheckSetup}>{AI.checkSetup}</Quiet>}
  </div>;
}

/** The real rewording request for the fictional example church, as the AI would get it (spec S8b "See exactly what is sent"). */
export function exampleRequest() {
  const capture = nov22Capture();
  const finding = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true)
    .findings.find(f => f.kind === "needs-people" && f.position);
  return finding ? buildRewordRequest(templateDraft({ finding, person_id: "example" }, capture.names), "warmer", capture.names) : null;
}
export function SentSheet({ onClose }: { onClose: () => void }) {
  const request = useMemo(exampleRequest, []);
  return <Sheet title={AI.sentTitle} onClose={onClose}>
    {request && <>
      <h3>{AI.sentInstructions}</h3>
      <p className="ai-pre">{request.system}</p>
      <h3>{AI.sentNote}</h3>
      <p className="ai-pre">{request.user}</p>
    </>}
    <p className="ai-body">{AI.sentAfter}</p>
    <div className="ai-actions"><button type="button" className="btn btn-primary ai-primary" onClick={onClose}>{AI.close}</button></div>
  </Sheet>;
}
