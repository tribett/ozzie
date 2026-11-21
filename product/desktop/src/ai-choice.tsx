// "How should Ozzie use AI?" (onboarding spec S6) and the way through it: Your church's own AI (S7), a key from an AI
// company (S8), AI on this Mac (S9) and Ozzie's AI (S10), with Back on every screen. First run and Settings show the very
// same screens; elsewhere they only drop the eyebrow and, opened over a page, name the page they go back to ("Back to
// Settings", "Back to Today"), on the first screen and after a working route. Nothing is chosen for the person, and Ozzie's
// AI is offered only when the server's offer is open.
import { useEffect, useMemo, useState } from "react";
import { SERVICES_PAGE } from "../../../core/src/service-day.js";
import { AI, CHOICE } from "./ai-words.js";
import { AiPlaceContext, InUseTag, Problem, Quiet, Screen, SentSheet, useAiPlace, type AiPlace, type InUse } from "./ai-parts.js";
import { CompaniesScreen, KeyScreen, OwnScreen } from "./ai-own-key.js";
import { ThisMacScreen } from "./ai-this-mac.js";
import { holdsOzzie, OzzieScreen } from "./ai-ozzie.js";
import { onboarding, type KeyProvider, type Offer, type OnboardingBridge } from "./onboarding-bridge.js";
import { model, type ModelStatus } from "./model.js";

/** Where the way through the AI screens is. Settings may start further in (a missing key, a check, connecting again). */
export type AiStep = { at: "choose" } | { at: "own" } | { at: "companies" } | { at: "key"; provider: KeyProvider } | { at: "mac" } | { at: "ozzie"; reconnect?: boolean };

export interface AiChoiceProps {
  mode: "first-run" | "settings";
  /** A route was saved: whether AI works through it now. */
  onModel: (configured: boolean) => void;
  /** "chosen": a working route, after its success line. "none": No AI for now. "later": not now. */
  onDone: (how: "chosen" | "none" | "later") => void;
  /** Every AI error's quiet "Check my setup" link. */
  onCheckSetup?: (() => void) | undefined;
  bridge?: OnboardingBridge;
  /**
   * Settings mode over a page: the page `onDone` goes back to, by its name in the sidebar, for the button after a working
   * route and for the first screen's way back ("Back to Today"). Without it (Settings' own AI section): "Back to Settings"
   * after a working route, and a bare "Back".
   */
  backTo?: string;
}

/** The AI screens from any step. `focusOnMount` false: shown with the page (Settings), so focus stays where it was until a step changes. */
export function AiFlow({ mode, onModel, onDone, onCheckSetup, bridge = onboarding, start = { at: "choose" }, focusOnMount = true, backTo }: AiChoiceProps & {
  start?: AiStep; focusOnMount?: boolean;
}) {
  const [step, setStep] = useState<AiStep>(start);
  const [moved, setMoved] = useState(false);
  const [offer, setOffer] = useState<Offer | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.offer().then(o => { if (live) setOffer(o); });
    return () => { live = false; };
  }, [bridge]);
  const place = useMemo<AiPlace>(() => ({ bridge, mode, onCheckSetup, focus: focusOnMount || moved }), [bridge, mode, onCheckSetup, focusOnMount, moved]);
  // Which way works now, read again as each screen opens (a way chosen on a later screen shows when the person comes back),
  // and whether this Mac still holds its connection to Ozzie's AI (`holdsOzzie`) or holds one ozzie.church refused.
  // Undefined until the first reading: then `held` is null, and neither the price nor Pay shows (review M3). A reading that
  // fails keeps the last one, so a screen never turns to the price while it is shown.
  const [now, setNow] = useState<ModelStatus | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    model.status().then(s => { if (live) setNow(s ?? null); }, () => { if (live) setNow(last => last === undefined ? null : last); });
    return () => { live = false; };
  }, [step.at]);
  const inUse: InUse = now?.configured === true && (now.route === "managed" || now.route === "own" || now.route === "local") ? now.route : null;
  const held = now === undefined ? null : holdsOzzie(now);
  const refused = now?.managed === "reconnect";
  const go = (s: AiStep) => { setStep(s); setMoved(true); };
  // The services' page by its name: "Next: open Services".
  const done = mode === "settings" ? AI.backTo(backTo ?? "Settings") : AI.next(SERVICES_PAGE);
  const chosen = () => onDone("chosen");
  const later = () => onDone("later");
  const back = start.at === step.at && start.at !== "choose" && mode === "settings" ? later : null;
  // "No AI for now" is an answer: native then has no route at all (contract N5 `set_no_ai`), and only then is it reported.
  const [noneFailed, setNoneFailed] = useState(false);
  const none = () => {
    setNoneFailed(false);
    bridge.setNoAi().then(s => { onModel(s?.configured === true); onDone("none"); }, () => setNoneFailed(true));
  };
  let screen;
  switch (step.at) {
    // A connection ozzie.church refused: connecting again, never the price, to a Mac it knew (live, 2026-11-19).
    case "choose": screen = <ChooseScreen offer={offer} inUse={inUse} held={held} refused={refused} onOzzie={() => go({ at: "ozzie", reconnect: refused })} onOwn={() => go({ at: "own" })} onNone={none} noneFailed={noneFailed} onLater={later}
      backLabel={backTo ? AI.backTo(backTo) : AI.back} />; break;
    case "own": screen = <OwnScreen inUse={inUse} onKey={() => go({ at: "companies" })} onMac={() => go({ at: "mac" })} onBack={back ?? (() => go({ at: "choose" }))} />; break;
    case "companies": screen = <CompaniesScreen onPick={p => go({ at: "key", provider: p })} onMac={() => go({ at: "mac" })} onBack={back ?? (() => go({ at: "own" }))} />; break;
    case "key": screen = <KeyScreen key={step.provider} provider={step.provider} onBack={back ?? (() => go({ at: "companies" }))} onLater={later} onModel={onModel} onDone={chosen} done={done}
      onCompanies={() => go({ at: "companies" })} onMac={() => go({ at: "mac" })} />; break;
    case "mac": screen = <ThisMacScreen onBack={back ?? (() => go({ at: "own" }))} onModel={onModel} onDone={chosen} done={done}
      // No AI for now from here is the choice screen's own (where its rare failure is said).
      onKey={() => go({ at: "companies" })} onNone={() => { go({ at: "choose" }); none(); }} />; break;
    case "ozzie": screen = <OzzieScreen offer={offer} reconnect={step.reconnect === true} held={held} heldAccount={now?.account ?? null} inUse={inUse === "managed"} onBack={back ?? (() => go({ at: "choose" }))} onLater={later}
      onAnother={() => go({ at: "choose" })} onModel={onModel} onDone={chosen} done={done} />; break;
  }
  return <AiPlaceContext.Provider value={place}>{screen}</AiPlaceContext.Provider>;
}

/** S6 and everything after it. In Settings it renders without the eyebrow. */
export function AiChoice(props: AiChoiceProps) {
  return <AiFlow {...props} />;
}

/**
 * S6: three cards, each one button with its title and cost line; none is chosen to begin with, and focus starts on the
 * title, never on a card. Ozzie's AI, when it can't be bought, stays in the Tab order with `aria-disabled` so its reason
 * is heard (review L11). `held`: this Mac still holds its connection to Ozzie's AI, so its card says so instead of the
 * price and can be chosen whatever the offer says (nothing is bought on the way); null until the AI status is read, when
 * the card waits as it does for the offer. `refused`: ozzie.church refused this Mac's connection, so the card leads to
 * connecting again, whatever the offer says (the website lets an account with a plan connect while sign-up is closed).
 */
function ChooseScreen({ offer, inUse, held, refused, onOzzie, onOwn, onNone, noneFailed, onLater, backLabel }: {
  offer: Offer | null; inUse: InUse; held: boolean | null; refused: boolean; onOzzie: () => void; onOwn: () => void; onNone: () => void; noneFailed: boolean;
  onLater: () => void;
  /** Settings mode's quiet way back: "Back to Today" over a page, "Back" in Settings' own AI section. */
  backLabel: string;
}) {
  const [sent, setSent] = useState(false);
  const settings = useAiPlace().mode === "settings";
  const open = offer?.open && offer.price_text && offer.answers_text ? CHOICE.ozzieCost(offer.price_text, offer.answers_text) : null;
  const shut = offer === null ? CHOICE.ozzieLooking : offer.reason === "unreachable" ? CHOICE.ozzieUnreachable : CHOICE.ozzieClosed;
  const ozzie = held === true || refused || (held === false && open !== null);
  const ozzieLine = held === null ? CHOICE.ozzieLooking : held ? CHOICE.ozzieHeld : refused ? CHOICE.ozzieReconnect : open ?? shut;
  return <Screen eyebrow={settings ? undefined : CHOICE.eyebrow} title={CHOICE.title}>
    <p className="ai-body">{settings ? CHOICE.bodySettings() : CHOICE.body()}</p>
    <ul className="ai-cards">
      <li><button type="button" className="ai-card" aria-disabled={ozzie ? undefined : true} onClick={() => { if (ozzie) onOzzie(); }}>
        <span className="ai-card-t">{CHOICE.ozzie}{inUse === "managed" && <InUseTag />}</span><span className="ai-card-d">{ozzieLine}</span>
      </button></li>
      <li><button type="button" className="ai-card" onClick={onOwn}>
        <span className="ai-card-t">{CHOICE.own}{(inUse === "own" || inUse === "local") && <InUseTag />}</span><span className="ai-card-d">{CHOICE.ownCost}</span>
      </button></li>
      <li><button type="button" className="ai-card" onClick={onNone}>
        <span className="ai-card-t">{CHOICE.none}</span><span className="ai-card-d">{settings ? CHOICE.noneCostSettings : CHOICE.noneCost}</span>
      </button></li>
    </ul>
    {noneFailed && <Problem text={CHOICE.noneFailed} />}
    <div className="ai-head">
      <p className="ai-body">{AI.namesLine}</p>
      <Quiet onClick={() => setSent(true)}>{AI.seeSent}</Quiet>
    </div>
    {!settings && <p className="ai-small">{CHOICE.small}</p>}
    <div className="ai-actions"><Quiet onClick={onLater}>{settings ? backLabel : CHOICE.later}</Quiet></div>
    {sent && <SentSheet onClose={() => setSent(false)} />}
  </Screen>;
}
