// First run (onboarding spec §1–§2, decisions 1, 11, 14): the first screen, the step before the browser, waiting for
// Allow, back with "Connected to {church}", then the service and its result; the AI screen once after that. It replaces
// the five-step guided setup. Which screen shows is decided from facts (first-run-state.ts) and from what the person
// pressed; it is never a trap: Back on the browser step, Cancel while waiting, "Not now" wherever a step can wait, and
// the sidebar leaves it without forgetting it. Escape closes only sheets; it never cancels a sign-in or a check.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { againFor, churchShort, connectOneClick, connection, parseSwitchQuestion, switchProblem, switchSettings, type ConnectionStatus, type SwitchDecision, type SwitchQuestion } from "./connection.js";
import { loadRules } from "./sunday-source.js";
import { loadRulesByChurch, rulesAtStake } from "./church-in-use.js";
import type { Settings } from "./sunday-source.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { onboarding, type OnboardingBridge, type PlanOption } from "./onboarding-bridge.js";
import {
  attemptOf, connectFailure, firstRunScreen, isConnected, isPending, RESUME_LINE, setupMemory as defaultMemory, type AiAnswer, type Failure, type FirstRunScreen,
} from "./first-run-state.js";
import { BrowserStep, ConnectedBanner, FirstScreen, NotMyChurchSheet, PromisesSheet, WaitingStep } from "./first-run-screens.js";
import { YourService, type ResultView } from "./your-service.js";
import { ConnectForm, SwitchQuestionPanel, useConnectionControl } from "./planning-center-forms.js";

const START_ASKED = "ozzie.start-with-mac-asked.v1";
/**
 * Whether "Start Ozzie when this Mac starts" has been answered on this Mac (now asked on Today's "Finish setting up").
 * Only that it was answered: the answer itself is the Mac's own login item.
 */
export const startMemory = {
  asked: (): boolean => { try { return localStorage.getItem(START_ASKED) === "1"; } catch { return false; } },
  answer: () => { try { localStorage.setItem(START_ASKED, "1"); } catch { /* per-device convenience only */ } },
};

/** Where first run is: one of the required screens, or the AI screen after the first result. */
type At = "first" | "browser" | "service" | "ai";
const atFrom = (start: FirstRunScreen): At => start === "waiting" ? "browser" : start;
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export function FirstRun({ status, settings, onSettings, onStatus, start, read, result, rules, intervalMinutes, nowMs, onExample, onLeave, onDeferred, onWatching, renderAi,
  bridge = onboarding, memory = defaultMemory(), builtIn: builtInProp, cards = 0, onDiscardCards, again = false, onDisconnectTried }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; onStatus: (s: ConnectionStatus) => void;
  /** Where it opened: from facts at launch, or from a button (Today's "Connect Planning Center", Settings, the example band). */
  start: FirstRunScreen;
  /** Reads the watched plan, the same check as every other (App's proactive.checkNow). */
  read: () => Promise<SundayCapture>;
  /** The result on screen once the first read finished. */
  result: ResultView | null;
  rules: boolean; intervalMinutes: number;
  /** This Mac's clock, ticked every second by App. */
  nowMs: number;
  /** "See an example church first": the example opens, and its band offers "Set up my church". */
  onExample: () => void;
  /** First run ends here for now: Today (after "Not now") or the service's own page (after the AI screen). */
  onLeave: (to: "today" | "sunday") => void;
  /** "Not now" on "Which service should Ozzie watch?". */
  onDeferred: () => void;
  /** The plan Ozzie now watches (its date and times only), so the pages name its real day at once. */
  onWatching?: ((plan: PlanOption, zone: string | null, service: string | null) => void) | undefined;
  /** The AI screen (ai-choice.tsx), once, after the first result; `done` when the person chose or left it. */
  renderAi?: (done: (how?: AiAnswer) => void) => ReactNode;
  bridge?: OnboardingBridge;
  memory?: ReturnType<typeof defaultMemory>;
  /** Tests only: whether Ozzie's own Planning Center registration is built in, instead of asking the app. */
  builtIn?: boolean;
  cards?: number; onDiscardCards?: (() => void) | undefined;
  /** This church already saw a result (a saved check exists): connecting again says so, with no step counter. */
  again?: boolean;
  /**
   * A Disconnect was tried here ("This isn't my church", or the sign-in form of a copy built by hand), however it ended:
   * native code turns changes off for that church either way, so App reads the switch again.
   */
  onDisconnectTried?: (() => void) | undefined;
}) {
  const [at, setAt] = useState<At>(atFrom(start));
  const [promises, setPromises] = useState(false);
  const [notMine, setNotMine] = useState(false);
  const [working, setWorking] = useState(false);
  const [thrown, setThrown] = useState<Failure | null>(null);
  // A status's failure is shown once an attempt is in view: one started here, or the one that opened setup at this step.
  const [attempted, setAttempted] = useState(start === "browser" || start === "waiting");
  const [triedHere, setTriedHere] = useState(false);
  const [justConnected, setJustConnected] = useState(false);
  const [resume] = useState(() => memory.get().lastAttempt);
  const [builtIn, setBuiltIn] = useState<boolean | null>(builtInProp ?? null);
  useEffect(() => {
    if (builtInProp !== undefined) return;
    let alive = true;
    void connection.appAvailable().then(v => { if (alive) setBuiltIn(v); });
    return () => { alive = false; };
  }, [builtInProp]);
  const control = useConnectionControl(settings, onStatus, status, builtInProp);
  // The internet, for the browser step's button (re-enabled when this Mac is back online).
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const on = () => setOffline(false), off = () => setOffline(true);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  // How the sign-in is going, from the native status (App polls it every second).
  const pending = isPending(status);
  const waitingSince = useRef<number | null>(null);
  if (pending && waitingSince.current === null) waitingSince.current = nowMs;
  if (!pending) waitingSince.current = null;
  const fromStatus = attempted ? connectFailure(status) : null;
  const failure = thrown ?? fromStatus;
  useEffect(() => {
    if (status?.state === "connected" && (at === "first" || at === "browser")) {
      memory.set({ lastAttempt: null });
      setThrown(null);
      setJustConnected(true);
      setAt("service");
    }
  }, [status?.state, at]);
  // Shown is offered: leaving the AI screen any way but a choice leaves "Choose how Ozzie uses AI" on Today (spec S6).
  useEffect(() => { if (at === "ai") memory.set({ aiOffered: true }); }, [at]);
  // How an attempt ended is kept, so a relaunch can say so (Quit cancels a waiting sign-in natively).
  useEffect(() => { if (fromStatus) memory.set({ lastAttempt: attemptOf(fromStatus) }); }, [fromStatus?.row]);

  const open = async () => {
    setThrown(null); setWorking(true); setAttempted(true); setTriedHere(true);
    memory.set({ lastAttempt: "cancelled" });
    try {
      if (pending) await connection.cancel().catch(() => undefined);
      // For a church saved on this Mac (Sign in again, Connect again), what it holds now (review 2026-11-18, late).
      onStatus(await connectOneClick(againFor(status, settings)));
    } catch (error) { setThrown(connectFailure(error)); }
    finally { setWorking(false); }
  };
  const cancel = async () => {
    setWorking(true);
    try { await connection.cancel(); const now = await connection.status(); if (now) onStatus(now); }
    catch { /* the next status poll says where it stands */ }
    finally { setWorking(false); setAt("browser"); }
  };
  const church = churchShort(status?.organization ?? "", status?.organization_name);
  const churchName = status?.organization_name ? church : "your church";

  // Row 9: a sign-in for another church while one is in use asks which church Ozzie uses, as Settings does.
  const question = parseSwitchQuestion(status?.switch);
  if (question) return <SwitchStep question={question} settings={settings} onSettings={onSettings} onStatus={onStatus} cards={cards} />;
  if (at === "ai" && renderAi) return <>{renderAi(how => { memory.set({ aiOffered: true, ...(how ? { aiAnswer: how } : {}) }); onLeave("sunday"); })}</>;
  if (pending && at !== "service") {
    return <WaitingStep checking={status?.state === "checking"} slow={waitingSince.current !== null && nowMs - waitingSince.current >= 4 * 60_000} working={working}
      onAgain={() => { void open(); }} onCancel={() => { void cancel(); }} />;
  }
  // The service step stays while the connection is unknown for a moment (a status not read yet); a refused or ended one
  // goes back to the browser step.
  if (at === "service" && (isConnected(status) || status === null)) {
    const banner = justConnected && status?.state === "connected"
      ? <ConnectedBanner church={churchName} checkedAt={status.checked_at_ms != null ? clock(status.checked_at_ms) : null} onNotMine={() => setNotMine(true)} /> : undefined;
    return <>
      <YourService bridge={bridge} settings={settings} onSettings={onSettings} church={churchName} read={read} result={result} rules={rules}
        intervalMinutes={intervalMinutes} aiOffered={memory.get().aiOffered || !renderAi} banner={banner} nowMs={nowMs} onDeferred={onDeferred} onWatching={onWatching}
        onNext={to => { if (to === "ai") { setAt("ai"); return; } onLeave(to); }} />
      {notMine && <NotMyChurchSheet church={churchName} working={working} onKeep={() => setNotMine(false)} onDisconnect={() => {
        setWorking(true);
        void connection.disconnect().then(after => {
          onStatus(after);
          if (after.state === "disconnected" && cards > 0) onDiscardCards?.();
          setNotMine(false); setJustConnected(false); setAttempted(false); setAt("browser");
        }, () => setNotMine(false)).finally(() => { setWorking(false); onDisconnectTried?.(); });
      }} />}
    </>;
  }
  if (at === "first" && !failure) {
    return <>
      <FirstScreen onConnect={() => setAt("browser")} onExample={() => { memory.set({ exampleSeen: true }); onExample(); }} onPromises={() => setPromises(true)} />
      {promises && <PromisesSheet onClose={() => setPromises(false)} />}
    </>;
  }
  const selfBuilt = builtIn === false
    ? <ConnectForm status={status} settings={settings} onSettings={onSettings} control={control} firstRun cards={cards} onDiscardCards={onDiscardCards} onDisconnectTried={onDisconnectTried} /> : undefined;
  return <BrowserStep failure={failure} resume={!triedHere && resume ? RESUME_LINE[resume] : null} offline={offline} working={working || builtIn === null}
    onOpen={() => { void open(); }} onBack={() => { setThrown(null); setAttempted(false); setAt("first"); }} onNotNow={() => onLeave("today")} selfBuilt={selfBuilt} again={again} />;
}

/** Whether first run opens by itself at launch, and where (spec §0.3): null once connected, watching and a result seen. */
export const firstRunAt = firstRunScreen;

/** "Switch Ozzie to this church?" inside first run: the same question, effects and answers as Settings (row 9). */
function SwitchStep({ question, settings, onSettings, onStatus, cards }: {
  question: SwitchQuestion; settings: Settings; onSettings: (s: Settings) => void; onStatus: (s: ConnectionStatus) => void; cards: number;
}) {
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  const answer = (decision: SwitchDecision) => {
    setWorking(true); setProblem("");
    void connection.answerSwitch(decision, question.id).then(async done => {
      onSettings(switchSettings(settings, done));
      onStatus(decision === "sign-in" ? await connection.connectAppAgain(question.to) : done.status);
    }).catch(error => {
      setProblem(switchProblem(error, question));
      void connection.status().then(now => { if (now) onStatus(now); }, () => undefined);
    }).finally(() => setWorking(false));
  };
  return <section className="fr" aria-label="Which church Ozzie uses">
    <SwitchQuestionPanel question={question} stake={rulesAtStake(question, loadRules(), loadRulesByChurch())} working={working} onAnswer={answer} cards={cards} />
    {problem && <p role="alert" className="problem">{problem}</p>}
  </section>;
}
