import { shouldRefreshStale } from "./stale-refresh.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  connection, followInUse, foundOrganization, fresher, needsSignIn, operationsAsked, operationsGranted, parseInUse, parseSwitchQuestion, pendingSettings, seenInUse, yourName,
  type ConnectionStatus,
} from "./connection.js";
import { adoptRules, loadRulesByChurch, moveRules, ofChurchInUse, onScreenCapture, rulesInUse, saveRulesByChurch } from "./church-in-use.js";
import { SwitchWaiting } from "./planning-center-forms.js";
import { CheckInsSunday, ChurchReadsRules, ChurchReadsToday } from "./church-reads-view.js";
import "./hearth.css";
import "./styles.css";
import { buildSundayBrief, sundayShownCount, teamLeaders } from "../../../core/src/sunday-brief.js";
import { captureToCoverage, type SundayCapture } from "../../../core/src/sunday-capture.js";
import { nov22Capture, nov22LaterCapture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { captureRooms, sundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, decisionsStorageKey, loadDecisions, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { CHECKING_LINE, STUCK_LINE, SundayPage, useSundayDecisions, type WhoCouldHelp } from "./sunday-page.js";
import { RulesPage } from "./rules-page.js";
import { ActivityPage } from "./activity-page.js";
import { ConnectionPage } from "./connection-page.js";
import { TodayPage } from "./today-page.js";
import { sundayCount, sundayCountText } from "./today-groups.js";
import { Icon } from "./icons.js";
import { model } from "./model.js";
import { devChurchRules, devKidsRules, responsibilityAutopilot, runAutopilot } from "./autopilot.js";
import { loadRules, loadSettings, refusedRead, saveRules, saveSettings, sundayProblem, sundaySource, type RecordingSummary } from "./sunday-source.js";
import { browserStore, desktopProactive, proactiveReadiness, verifySavedOnLaunch, type ProactiveHooks } from "./proactive.js";
import { ProactivePage, useProactiveView } from "./proactive-page.js";
import { AskIcon, AskPanel, type AskFn, type PlanHooks } from "./ask-panel.js";
import type { Skill } from "../../../core/src/harness/contract.js";
import type { HarnessData } from "../../../core/src/harness/index.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { composeAnswer } from "../../../core/src/harness/compose.js";
import { parseRequest } from "../../../core/src/harness/responsibilities.js";
import {
  askOzzie, buildHarnessData, createAppHarness, desktopRecorder, devLoop, enableDebugLines, grantedFor, localTriggers, procedures as loadProcedures,
  keptWriteup, lookAtWhoCouldHelp, PROCEDURE_ORDER, stepNotes, type LoopChoice,
} from "./harness-bridge.js";
import { modelSteps, type TaskRow } from "./harness-words.js";
import { KeptCards } from "./cards-page.js";
import { FirstRun, startMemory } from "./setup-flow.js";
import { aiStillOpen, firstRunScreen, setupMemory, type FirstRunScreen } from "./first-run-state.js";
import { decideService, type ResultView } from "./your-service.js";
import { decisionLines, type RegularCheck } from "./today-groups.js";
import { DayProvider, dayWords, UNKNOWN_WORDS, type DayWords } from "./day-words.js";
import { promise } from "./promises.js";
import { AiChoice, AiFlow, type AiStep } from "./ai-choice.js";
import { MacEndedLine, OllamaEndedLine, thisMacShown } from "./ai-this-mac.js";
import { AiLine, ChooseAiContext } from "./ai-line.js";
import { FinishSettingUp } from "./finish-list.js";
import { kidsFacts, kidsTeamToAsk, moments } from "./moments.js";
import { KidsQuestion, markKidsTeam } from "./kids-question.js";
import { ReadMore, readMoreMemory, readMoreNeed } from "./read-more.js";
import { useOperationsReads } from "./operations-reads.js";
import { PhoneMoment, phoneMomentNow } from "./phone-moment.js";
import { CheckMySetup } from "./check-setup.js";
import { hasPassed, moveOn, WAIT_AGAIN_MS, waitingText, type WatchedPlan } from "./move-on.js";
import { dayName, noticeDayOf } from "./day-phrases.js";
import { onboarding, type ModelProgress, type NoticeDay, type OllamaHistory, type OllamaProgress } from "./onboarding-bridge.js";
import { kidsTeams } from "../../../core/src/kids-rules.js";
import { pausedWhen, type ModelStatus } from "./model.js";
import { askedMark, askedMemory, askedText, holding, type AskedMark } from "./asked.js";
import type { AskedLine, AskedSlot } from "./sunday-page.js";
import { localDate } from "../../../core/src/church-time.js";
import { planTimes } from "../../../core/src/service-day.js";
import { openInPlanningCenter } from "./planning-center-pages.js";
import { invoke } from "@tauri-apps/api/core";
import { autostart, background, quitting, startProbe } from "./background.js";
import { QuitQuestion, useQuitGuard, type QuitAsk } from "./quit-question.js";
import { allowanceSpent, createRunner, handChanges, nativeResponsibilities, responsibilityStep, type RunnerHooks } from "./responsibility-runner.js";
import { ResponsibilityList, useRunnerView, type PlanActions, type PlanContext } from "./responsibility-views.js";
import { feedbackOf } from "../../../core/src/finding-feedback.js";
import type { FeedbackSource } from "./finding-feedback.js";
import { useSharing } from "./share-check.js";
import { useOpenedPage, useShortcuts } from "./siri-shortcuts.js";
import { updates, useUpdates } from "./updates.js";
import { UpdateLine, UpdatesSection } from "./updates-view.js";
import { calendarsConnected, createCalendars, useCalendarState } from "./calendars.js";
import { CalendarSettings } from "./calendar-settings.js";
import { createChurchSources, useChurchSources } from "./church-sources.js";
import { ChurchListsPage } from "./church-lists-page.js";
import { createWindowVisible } from "./window-visible.js";
import { ChurchOwnWords } from "./church-own-words.js";

type Page = "today" | "sunday" | "cards" | "rules" | "lists" | "automatic" | "activity" | "connection";
/** The sidebar's pages. The service's own page is named by its real day ("Sunday", "Saturday", "This weekend"). */
const navFor = (day: DayWords): { id: Page; label: string; icon: string }[] => [
  { id: "today", label: "Today", icon: "clock" }, { id: "sunday", label: day.page, icon: "sun" }, { id: "cards", label: "Visitor cards", icon: "user" },
  { id: "rules", label: "Church rules", icon: "rules" }, { id: "lists", label: "Church lists", icon: "table" },
  { id: "automatic", label: "Keeping watch", icon: "repeat" },
  { id: "activity", label: "What happened", icon: "history" }, { id: "connection", label: "Settings", icon: "sliders" },
];
/**
 * A page named mid-sentence ("Back to Today"): the service's page as a sentence says it ("Sunday", "this weekend", "your
 * service"), every other page by its sidebar name.
 */
export const backToName = (page: Page, day: DayWords): string => page === "sunday" ? dayName(day) : navFor(day).find(n => n.id === page)?.label ?? "Today";
/** The sidebar's first entry while setup is unfinished (review M11). */
export const SETTING_UP = "Setting up";
const WATCHED_DAY = "ozzie.watched-day.v1";
/** The last "Moved on to …" sentence and when, shown on Today for a day. */
const MOVED_ON = "ozzie.moved-on.v1";
/**
 * The watched plan's date and service times (no names), kept so the pages name its real day from launch, before this
 * session's first check has read it. Only for the plan Settings watch.
 */
const watchedDay = {
  get(planId: string): { sort_date: string | null; times: string[]; zone: string | null; service: string | null } | null {
    try {
      const v = JSON.parse(localStorage.getItem(WATCHED_DAY) ?? "null") as { planId?: unknown; sort_date?: unknown; times?: unknown; zone?: unknown; service?: unknown } | null;
      if (!v || v.planId !== planId) return null;
      return { sort_date: typeof v.sort_date === "string" ? v.sort_date : null, times: Array.isArray(v.times) ? v.times.filter((t): t is string => typeof t === "string").slice(0, 12) : [],
        zone: typeof v.zone === "string" ? v.zone : null, service: typeof v.service === "string" ? v.service.slice(0, 120) : null };
    } catch { return null; }
  },
  /** `service`: the service's own Planning Center name ("Youth Night"), kept from what was last known when not given. */
  set(planId: string, sort_date: string | null, times: string[], zone: string | null, service?: string | null) {
    const kept = service === undefined ? watchedDay.get(planId)?.service ?? null : service;
    try { localStorage.setItem(WATCHED_DAY, JSON.stringify({ planId, sort_date, times: times.slice(0, 12), zone, service: kept })); } catch { /* per-device convenience only */ }
  },
};
const proactive = desktopProactive();
// Keeping watch (responsibility-runner.ts): one per webview, like the Sunday schedule.
// Debug builds only: a fast schedule and name-free lines for the developer's terminal.
const debugRunner = { fast: false, lines: false };
const runner = createRunner({
  native: nativeResponsibilities(), store: browserStore, now: () => new Date().toISOString(),
  // A notice sent on this Mac is remembered (that one was sent, nothing else), for the phone question on Today (spec §4.2).
  notify: (kind, options) => background.notify(kind, options).then(sent => { moments.noticeSent(); return sent; }),
  nextDue: background.nextDue, fast: () => debugRunner.fast,
  log: line => { if (debugRunner.lines) void invoke("dev_log", { line }).catch(() => undefined); },
});
const macZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Whether the window is on screen: being "seen in Ozzie" needs a person who can see it (window-visible.ts). */
const onScreen = createWindowVisible(typeof document === "undefined" ? undefined : document, typeof window === "undefined" ? undefined : window);
function useWindowVisible(): boolean {
  const [shown, setShown] = useState(onScreen.visible);
  useEffect(() => onScreen.subscribe(setShown), []);
  return shown;
}

/** `value` as it was before `hold` began, for as long as it holds; `value` itself otherwise. */
function useHeldWhile<T>(value: T, hold: boolean): T {
  const before = useRef(value);
  useEffect(() => { if (!hold) before.current = value; });
  return hold ? before.current : value;
}

/** Dark appearance follows this Mac's setting, live. Hearth's dark tokens apply under `.oz.dark`. */
function useDarkAppearance(): boolean {
  const query = () => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [dark, setDark] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const q = query();
    if (!q) return;
    const changed = () => setDark(q.matches);
    changed();
    q.addEventListener("change", changed);
    return () => q.removeEventListener("change", changed);
  }, []);
  return dark;
}

/** The words on the fictional example's band (audit item 2): true on every page while the example is on. */
export const EXAMPLE_BAND = { title: "Example church, not real.", body: "The Sunday, teams, people and email shown are made up. Your own Church rules, lists, settings and visitor cards are real.",
  setUp: "Set up my church", leave: "Leave the example" } as const;
/** Across the top of every page while the fictional example is on, with the way into setup and a way out. */
export function ExampleBand({ onLeave, onSetUp }: { onLeave: () => void; onSetUp?: () => void }) {
  return <div className="example-band" role="note">
    <Icon name="info" />
    <p><strong>{EXAMPLE_BAND.title}</strong> {EXAMPLE_BAND.body}</p>
    {onSetUp && <button type="button" className="btn btn-primary btn-sm" onClick={onSetUp}>{EXAMPLE_BAND.setUp}</button>}
    <button type="button" className="btn btn-secondary btn-sm" onClick={onLeave}>{EXAMPLE_BAND.leave}</button>
  </div>;
}

/** How long launch waits for a native answer it needs before going on without it (review L6). */
export const LAUNCH_WAIT_MS = 20_000;

export function App() {
  const [page, setPage] = useState<Page>("today");
  const [status, setShownStatus] = useState<ConnectionStatus | null>(null);
  // Native statuses carry a revision: one read before an answer but arriving after it is ignored (review S, L5).
  const newestStatus = useRef(0);
  const setStatus = useCallback((next: ConnectionStatus | null) => {
    if (!fresher(next, newestStatus.current)) return;
    if (next?.revision !== undefined) newestStatus.current = next.revision;
    // Every status passes here (the poll, the scheduler, the launch check, Settings and setup): one that is disconnected
    // forgets every write-up, including one still being prepared (review H, M4; review G, N2).
    if (next?.state === "disconnected") runner.forgetAllWriteups();
    setShownStatus(next);
  }, []);
  const [settings, setSettings] = useState(loadSettings);
  // Church rules as set, and the church-specific ones kept for other churches (church-in-use.ts).
  const [savedRules, setRules] = useState(loadRules);
  // Rules saved before they were kept per church belong to the church in Settings, where they were set (review S2, M3).
  const [rulesByChurch, setRulesByChurch] = useState(() => adoptRules(loadRulesByChurch(), loadSettings().organization));
  const [heldCapture, setCapture] = useState<SundayCapture | null>(null);
  const [fictional, setFictional] = useState(false);
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // Planning Center refused the last check: the Sunday page says which access and what next (audit item 5).
  const [refused, setRefused] = useState(false);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [modelReady, setModelReadyFlag] = useState(false);
  // Which AI Ozzie uses, as native says (never a key): the sidebar's AI line, Finish setting up and Check my setup.
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  // Ask reads the latest account (for when a pause ends) without being rebuilt on every status read.
  const modelStatusRef = useRef<ModelStatus | null>(null);
  modelStatusRef.current = modelStatus;
  const readModel = useCallback(() => { model.status().then(st => { setModelStatus(st); setModelReadyFlag(st.configured); }, () => undefined); }, []);
  const setModelReady = useCallback((configured: boolean) => { setModelReadyFlag(configured); readModel(); }, [readModel]);
  // "Change" on the AI line, Finish setting up and Check my setup open the AI screen (S6) over the page; Check my setup has its own view.
  const [aiChoosing, setAiChoosing] = useState(false);
  const [checking, setChecking] = useState(false);
  // Each opening starts afresh at "How should Ozzie use AI?", at the top, also while those screens are already open (a
  // key guide's "It works." included: live, 2026-11-18). Starting afresh lets go of a check still running, which native
  // may still finish by saving its route, so the AI in use is read again here and on leaving (review L5).
  const [aiOpened, setAiOpened] = useState(0);
  // Where the screens open: "How should Ozzie use AI?", or AI on this Mac from Today's line about a download (review M-1).
  const [aiStart, setAiStart] = useState<AiStep>({ at: "choose" });
  const openAiAt = (start: AiStep) => { setChecking(false); setAiStart(start); setAiChoosing(true); setAiOpened(n => n + 1); readModel(); };
  // Handed to buttons as their click handler: never takes the click as where to start.
  const openAi = () => openAiAt({ at: "choose" });
  // Leaving them goes back to the page under them, which their last button names: Settings opens at its AI help section.
  const [settingsAt, setSettingsAt] = useState<"ai-title" | null>(null);
  // First run (onboarding spec §0.3): decided from facts once launch settles ("auto"), then open at a screen or closed
  // (null). Today, the example band and Settings reopen it at the screen that fits.
  const [setup, setSetup] = useState<FirstRunScreen | null | "auto">("auto");
  const [setupMemo] = useState(() => setupMemory());
  // "Download and set up" carries on natively after its screen is left or the window closed (ai_setup.rs), and on
  // "answers" native switches to it unless another choice of AI was made since the press. Its ending is heard here, for
  // as long as Ozzie runs: the AI in use is read again, and when no AI on this Mac screen showed the ending, Today says
  // how it ended in one line (review M-1).
  const [macEnded, setMacEnded] = useState<ModelProgress | null>(null);
  useEffect(() => onboarding.onModelProgress(p => {
    if (p.end === null) return;
    readModel();
    if (p.end === "done" && p.check?.verdict === "answers") setupMemo.set({ aiOffered: true, aiAnswer: "chosen" });
    setMacEnded(thisMacShown() ? null : p);
  }), [readModel, setupMemo]);
  // Getting Ollama carries on natively too (ollama_setup.rs): its ending, when no AI on this Mac screen showed it, is one
  // line on Today in the install's own words, as for a model's download.
  const [ollamaEnded, setOllamaEnded] = useState<OllamaProgress | null>(null);
  useEffect(() => onboarding.onOllamaProgress(p => {
    if (p.end === null) return;
    setOllamaEnded(thisMacShown() ? null : p);
  }), []);
  // Each opening starts fresh at its screen.
  const [setupKey, setSetupKey] = useState(0);
  const [statusRead, setStatusRead] = useState(false);
  // The launch's check of the saved sign-in has answered (or failed): native holds no connection status before it, so
  // first run decides only after it (0.3.0 relaunch bug: an unknown status opened the first screen, which then jumped
  // to the service step once the check said connected).
  const [launchChecked, setLaunchChecked] = useState(false);
  // That check, or another launch command, had no answer after LAUNCH_WAIT_MS: launch went on without it (review L6).
  const [launchStuck, setLaunchStuck] = useState(false);
  // "Check the connection" after that: the saved sign-in is being checked again.
  const [rechecking, setRechecking] = useState(false);
  const [recordingsFor, setRecordingsFor] = useState<string | null>(null);
  // "Not now" on "Which service should Ozzie watch?": Today's "Finish setting up" holds it.
  const [, setServiceDeferred] = useState(false);
  // Bumped when first run picks a plan, so the pages name its day before its first read ends.
  const [watchVersion, setWatchVersion] = useState(0);
  // Checks start once launch has settled; the first read waits for that, so it is the same check as every other.
  const [started] = useState(() => { let resolve = () => {}; const ready = new Promise<void>(r => { resolve = r; }); return { ready, resolve }; });
  // Visitor cards (audit item 20): the page stays mounted once opened, so its cards are kept while Ozzie is open, hidden
  // on other pages; App hears only how many are open, for the question on quitting.
  const [cardsOpened, setCardsOpened] = useState(false);
  // Each Disconnect the leader chose with cards open ends them (cards-page.tsx `KeptCards`, review P L4).
  const [cardsDiscarded, setCardsDiscarded] = useState(0);
  const discardCards = () => setCardsDiscarded(n => n + 1);
  const [openCards, setOpenCards] = useState(0);
  // "Start Ozzie when you turn on this Mac?" (audit item 23): asked in setup, or once on Today of an install set up
  // before setup asked it, while Ozzie doesn't start with the Mac. Never changed without the leader's click.
  const [startAsked, setStartAsked] = useState(() => startMemory.asked());
  const [startOn, setStartOn] = useState<boolean | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const answerStart = (on: boolean) => {
    setStartFailed(false);
    void autostart.set(on).then(now => { startMemory.answer(); setStartAsked(true); setStartOn(now); }, () => setStartFailed(true));
  };
  // Native code asks before quitting from Ozzie's menu or with Command-Q (audit items 20 and 23, review P M1): what quitting
  // would stop or lose, counts only.
  const [quitAsk, setQuitAsk] = useState<QuitAsk | null>(null);
  // A Sunday card Today asked to open at (audit item 17).
  const [sundayFocus, setSundayFocus] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);
  // The debug-only hidden-window probe and stand-in update test never read the Keychain (where the AI key lives).
  useEffect(() => {
    void Promise.all([background.info(), updates.status().catch(() => null)]).then(([info, update]) => {
      if (!info.probe && !update?.probe) model.status().then(st => { setModelStatus(st); setModelReadyFlag(st.configured); }).catch(() => setModelReadyFlag(false));
    });
  }, []);
  // New versions of Ozzie (updater.rs): Settings' Updates section and, when one is ready, a line above Today.
  const updateState = useUpdates();
  // The leader's own calendars on Today (calendars.ts): read on this Mac, kept in memory, never sent anywhere. Like
  // the AI key, private links live in the Keychain, so the probes above never read them.
  const [calendars] = useState(() => createCalendars());
  const calendarState = useCalendarState(calendars);
  // macOS's calendar question may be answered while Ozzie isn't in front; coming forward picks the answer up.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const forward = () => { void calendars.refreshAccess(); };
    window.addEventListener("focus", forward);
    return () => window.removeEventListener("focus", forward);
  }, [calendars]);
  useEffect(() => {
    void Promise.all([background.info(), updates.status().catch(() => null)]).then(([info, update]) => {
      if (!info.probe && !update?.probe) void calendars.load();
    }).catch(() => undefined);
  }, [calendars]);
  // One set of placeholder labels for the whole app, so a person or role keeps its label across questions.
  const [harnessSession] = useState(() => new HarnessSession());
  // Ask Ozzie opens when the leader chooses, on any width (audit item 8), and stays as they left it while Ozzie runs.
  const [askOpen, setAskOpen] = useState(false);
  // Ozzie's procedures (core/skills), checked and hashed once; shown on Church rules and followed by Ask.
  const [procedures, setProcedures] = useState<ReadonlyMap<string, Skill> | null>(null);
  useEffect(() => { loadProcedures().then(setProcedures).catch(() => setProcedures(null)); }, []);
  const orderedProcedures = useMemo(() => procedures ? PROCEDURE_ORDER.flatMap(id => procedures.get(id) ?? []) : null, [procedures]);
  const [focusProcedure, setFocusProcedure] = useState<string | null>(null);
  // A page opens at its top: the work column keeps one scroll position, so without this a new page
  // would open wherever the last one was left. Opening a procedure scrolls to it instead (rules-page).
  const mainRef = useRef<HTMLElement>(null);
  // Debug builds only (dev_defaults reports something only there): developer lines and the loop choice.
  const [debug, setDebug] = useState(false);
  const [loop, setLoop] = useState<LoopChoice>("pi");
  const recorder = desktopRecorder();
  const [triggers] = useState(() => localTriggers());
  // What happened: the task ledger, newest first. undefined while loading; null when it isn't available.
  const [tasks, setTasks] = useState<TaskRow[] | null | undefined>(undefined);
  // What happened also lists each time Ozzie got Ollama (native `ollama_install_history`: times and closed words only).
  const [ollamaDone, setOllamaDone] = useState<OllamaHistory["done"] | null>(null);
  const [ledgerVersion, setLedgerVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    // A status native couldn't give counts as read too (as unknown), so a launch never waits on it for good.
    const update = () => connection.status().then(v => { if (alive) { setStatus(v); setStatusRead(true); } }).catch(() => { if (alive) setStatusRead(true); });
    void update();
    const timer = setInterval(() => { void update(); setNow(new Date().toISOString()); }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [setStatus]);
  // One-click sign-in: remember the organization Planning Center named (once per sign-in).
  const appliedFound = useRef<string | null>(null);
  useEffect(() => {
    const found = foundOrganization(settings, status, appliedFound.current);
    if (!found) return;
    appliedFound.current = found.key;
    setSettings(found.settings);
  }, [status, settings]);
  // "Switch Ozzie to this church?" is open: Settings keeps the church Ozzie still uses until the person answers.
  const switchQuestion = parseSwitchQuestion(status?.switch);
  useEffect(() => {
    const kept = pendingSettings(settings, parseSwitchQuestion(status?.switch));
    if (kept) setSettings(kept);
  }, [status, settings]);
  // The church Ozzie uses natively. When it changes (an answer, a launch, a window reopened mid-answer), Settings follow
  // it, keeping the chosen Sunday when it is the church last seen in use on this Mac (review S3, L1).
  const inUse = parseInUse(status?.in_use);
  const inUseOrg = inUse?.organization;
  const lastInUse = useRef<string | null>(null);
  const seenChurch = useRef<string | null>(seenInUse.get());
  const churchNames = useRef(new Map<string, string>());
  if (inUse?.name) churchNames.current.set(inUse.organization, inUse.name);
  useEffect(() => {
    const next = followInUse(settings, parseInUse(status?.in_use), lastInUse.current, seenChurch.current);
    lastInUse.current = next.last;
    if (next.last && next.last !== seenChurch.current) { seenChurch.current = next.last; seenInUse.set(next.last); }
    if (next.settings) setSettings(next.settings);
  }, [status, settings]);
  // Church rules for one church's teams, rooms and findings stay with that church (church-in-use.ts).
  useEffect(() => {
    if (!inUseOrg) return;
    const moved = moveRules(savedRules, rulesByChurch, inUseOrg, churchNames.current.get(rulesByChurch.church), settings.organization);
    if (!moved) return;
    setRules(moved.rules);
    setRulesByChurch(moved.store);
  }, [inUseOrg]);
  useEffect(() => saveRulesByChurch(rulesByChurch), [rulesByChurch]);
  // A job's write-ups belong to the church they were read from: another church's are forgotten (audit item 6).
  useEffect(() => { if (inUseOrg) runner.keepWriteupsFor(inUseOrg); }, [inUseOrg]);
  const rules = rulesInUse(savedRules, rulesByChurch, inUseOrg, settings.organization);
  // The church Ozzie last used, kept while the church in use drops out for a moment (a Keychain write): Ask's answers
  // belong to it, and start afresh with another church (review S2, L2).
  const askChurch = useRef<string | undefined>(undefined);
  if (inUseOrg) askChurch.current = inUseOrg;
  const org = /^[1-9]\d{0,31}$/.test(settings.organization) ? settings.organization : "";
  // Nothing read from another church is shown or used: the check on screen must be this church's (church-in-use.ts),
  // and a check of a church Ozzie no longer uses is let go.
  const capture = onScreenCapture(heldCapture, fictional, org, inUseOrg);
  useEffect(() => {
    if (heldCapture && !fictional && inUseOrg !== undefined && heldCapture.organization !== inUseOrg) setCapture(null);
  }, [heldCapture, fictional, inUseOrg]);
  const refreshRecordings = () => {
    const forOrg = org;
    const done = (list: RecordingSummary[]) => { setRecordings(list); setRecordingsFor(forOrg); };
    if (forOrg) sundaySource.recordings(forOrg).then(done).catch(() => done([])); else done([]);
  };
  useEffect(refreshRecordings, [org]);
  useEffect(() => saveSettings(settings), [settings]);
  // Scheduled checks read the latest app state through refs; they never change what the person typed.
  const current = useRef({ settings, rules, status, fictional, refreshRecordings, inUseOrg });
  const noticeDayRef = useRef<NoticeDay | undefined>(undefined);
  current.current = { settings, rules, status, fictional, refreshRecordings, inUseOrg };
  // A live check is acted on only if it is of the church Ozzie uses now: one that finishes, or is shared, after a switch
  // is dropped by every consumer (review S2, L1).
  const belongs = (c: SundayCapture) => ofChurchInUse(c, current.current.settings.organization, current.current.inUseOrg);
  const automatic = useProactiveView(proactive);
  const hooks: ProactiveHooks = useMemo(() => ({
    // The notice names the watched service's real day (a closed code, never text: spec §5.2, contract N8).
    context: () => ({ ...current.current, ...(noticeDayRef.current ? { noticeDay: noticeDayRef.current } : {}) }),
    onStatus: setStatus,
    onCapture: (c, trigger) => {
      // Responsibilities due soon share this check rather than reading Planning Center again.
      if (belongs(c)) runner.captured(c);
      current.current.refreshRecordings();
      void desktopRecorder().idle().then(() => setLedgerVersion(v => v + 1));
      // A scheduled check shows its result unless the person is looking at the fictional example.
      if (trigger !== "manual" && !current.current.fictional) { setCapture(c); setNow(new Date().toISOString()); }
    },
    // Something got worse: Keep Sunday covered may check sooner, and then sends the one notice about it.
    onChanges: handChanges(runner),
  }), []);
  useEffect(() => () => proactive.stop(), []);
  // Seen in Ozzie only while the window is on screen: with it closed, Ozzie keeps running in the menu bar.
  const visible = useWindowVisible();
  useEffect(() => { if (page === "automatic" && visible) proactive.markSeen(); }, [page, automatic.unseen, visible]);
  useEffect(() => { if (page === "cards") setCardsOpened(true); }, [page]);
  // Run a due check as soon as a saved connection and a chosen Sunday are known, not at the next timer tick.
  const readiness = proactiveReadiness(settings, status);
  useEffect(() => { if (readiness === "ready") { void proactive.tick(); void runner.tick(); } }, [readiness]);
  // Keeping watch reads the latest app state through refs, like the Sunday schedule.
  const watch = useRunnerView(runner);
  useEffect(() => { if ((page === "automatic" || page === "today") && visible) runner.markSeen(); }, [page, watch.unseen, visible]);
  // Today in front: read the calendars again once the last read is over 15 minutes old (checked as the clock ticks).
  useEffect(() => { if (page === "today" && visible) void calendars.readIfOld(); }, [page, visible, calendars, now]);
  // The church's own lists (church-sources.ts): read on this Mac, kept in memory, shown only on Church lists and beside
  // a matched Sunday card. Read when one of those pages is opened or the window comes forward, again then once the last
  // read is over an hour old; never as the clock ticks, since a private link's read is a request to the internet.
  const [churchSources] = useState(() => createChurchSources());
  const sourcesState = useChurchSources(churchSources);
  useEffect(() => { if ((page === "sunday" || page === "lists") && visible) void churchSources.readIfOld(); }, [page, visible, churchSources]);
  const runnerState = useRef({ readiness, status, rules, decisions: [] as readonly SundayDecision[], modelReady,
    prefs: automatic.prefs, zone: macZone(), procedures, loop, workspace: "this-mac", capture, fictional, configured: false, sunday: null as string | null });
  const runnerHooks: RunnerHooks = useMemo(() => ({
    context: () => {
      const s = runnerState.current;
      return {
        ready: s.readiness === "ready", granted: grantedFor(s.fictional ? null : s.capture, false, s.status), rules: s.rules,
        zone: s.zone, macZone: macZone(), quiet: { start: s.prefs.quietStart, end: s.prefs.quietEnd }, urgentDuringQuiet: s.prefs.urgentDuringQuiet,
        urgentWithinHours: s.prefs.urgentWithinHours,
        modelReady: s.modelReady,
        // The leader's decisions about that check's Sunday, as the Sunday page applies them, so Keep Sunday covered counts
        // what the page shows (review item 2). A live check and a saved copy of the same Sunday share them.
        decisionsFor: c => { try { return loadDecisions(localStorage, decisionsStorageKey("live", c.organization, c.plan_id)); } catch { return []; } },
      };
    },
    // The same check as "Check Planning Center now" (one at a time, recorded in the task ledger as automatic).
    check: async () => {
      const c = await proactive.checkNow("automatic");
      if (!current.current.fictional) { setCapture(c); setNow(new Date().toISOString()); }
      void desktopRecorder().idle().then(() => setLedgerVersion(v => v + 1));
      return c;
    },
    belongs,
    // With an AI model: the template's procedure through the harness, each step paid from this run's grant. Its
    // write-up is kept with the run, people as id tokens (harness-bridge keptWriteup); it decides nothing.
    prepare: async (r, grant, c, signal, trigger) => {
      const s = runnerState.current;
      if (!s.procedures || !belongs(c)) return null;
      const data = buildHarnessData({ capture: c, fictional: false, rules: s.rules, decisions: s.decisions, status: s.status, configured: s.configured, now: new Date().toISOString() });
      const h = createAppHarness({ workspace_id: s.workspace, data, skills: s.procedures, session: harnessSession, loop: s.loop, recorder: desktopRecorder(), step: responsibilityStep(grant.run_id) });
      const observer = desktopRecorder().task("skill", r.skill_id, trigger ? `job:${r.template}:${trigger}` : undefined);
      // A pause aborts the run's signal, which stops the AI work at once (the loop cancels its step and tools).
      const outcome = await h.runSkill(r.skill_id, { onEvent: observer.onEvent, ...(signal ? { signal } : {}) });
      void desktopRecorder().idle().then(() => setLedgerVersion(v => v + 1));
      const ai_steps = modelSteps(outcome.events);
      // A "limit" from a spent allowance, not this run's own limit, as native named it (review G).
      const native = stepNotes.take(outcome.events[0]?.task_id ?? "");
      if (outcome.status !== "verified" || !outcome.answer) {
        return { status: outcome.status, code: outcome.code, writeup: null, ai_steps, allowance: allowanceSpent(native), noCredit: native === "no-credit" };
      }
      const writeup = keptWriteup(h, outcome);
      const task = outcome.events[0]?.task_id;
      if (task) desktopRecorder().ended(task, composeAnswer(outcome.answer, outcome.evidence).kind);
      return { status: "verified", code: null, writeup, ai_steps };
    },
  }), [harnessSession]);
  // The native timer wakes the page (even with the window closed), reports Mac sleep, Pause everything
  // from the menu bar, and the window coming back (a briefing that was announced opens Today).
  useEffect(() => {
    const openToday = () => { if (runner.view().open_today && onScreen.visible()) { setPage("today"); runner.clearOpenToday(); } };
    const stop = background.on({
      tick: () => { void runner.tick(); void proactive.tick(); },
      wake: (slept, at) => runner.wake(slept, at),
      // Pause everything takes effect at once; lifting it puts the Sunday check back as it was.
      paused: paused => { proactive.pauseWithEverything(paused); void runner.pausedElsewhere(paused); },
      shown: openToday,
      quitAsked: setQuitAsk,
    });
    document.addEventListener("visibilitychange", openToday);
    return () => { stop(); document.removeEventListener("visibilitychange", openToday); };
  }, []);
  // Fill only empty fields; never overwrite what the person entered.
  // Automatic checks start after this settles, so they never race the developer autopilot.
  useEffect(() => {
    let begun = false;
    const begin = () => { if (begun) return; begun = true; proactive.start(hooks); runner.start(runnerHooks); started.resolve(); };
    let checkedOnce = false;
    const launchCheckDone = (stuck: boolean) => { if (checkedOnce) return; checkedOnce = true; if (stuck) setLaunchStuck(true); setLaunchChecked(true); };
    // A native launch command that never answers never leaves the page stuck (review L6): after LAUNCH_WAIT_MS launch
    // decides anyway (a brand-new Mac gets the first screen; a set-up church keeps its saved check) and checks start.
    const waited = setTimeout(() => { setLaunched(true); setStatusRead(true); launchCheckDone(true); begin(); }, LAUNCH_WAIT_MS);
    void background.info().then(info => {
      debugRunner.fast = info.fastSchedule;
      if (info.probe) background.on(startProbe(line => { void invoke("dev_log", { line }).catch(() => undefined); }));
    });
    sundaySource.devDefaults().then(d => {
      const merged = (s: typeof settings) => ({
        clientId: s.clientId || d.clientId, organization: s.organization || d.organization,
        serviceTypeId: s.serviceTypeId || d.serviceTypeId, planId: s.planId || d.planId,
      });
      setSettings(merged);
      // Release builds report nothing here, so anything reported means a debug build.
      const isDebug = Boolean(d.clientId || d.organization || d.serviceTypeId || d.planId || d.autopilot || d.autopilotOperations);
      const chosenLoop = devLoop.get(isDebug);
      if (isDebug) { setDebug(true); setLoop(chosenLoop); enableDebugLines(); debugRunner.lines = true; }
      if (d.autopilot) {
        // The developer autopilot starts the checks itself, when it is done.
        clearTimeout(waited);
        setSetup(null); launchCheckDone(false);
        setPage("sunday");
        void runAutopilot(merged(loadSettings()), devChurchRules(devKidsRules(loadRules(), d.kidsTeams), d.forms), Boolean(d.autopilotOperations), c => { setCapture(c); setFictional(false); refreshRecordings(); },
          { recorder, loop: chosenLoop }, Boolean(d.autopilotOneClick), { checkIns: Boolean(d.autopilotCheckIns), registrations: Boolean(d.autopilotRegistrations) })
          .then(() => model.status().then(s => setModelReady(s.configured)).catch(() => undefined))
          .finally(() => {
            begin();
            // Then a responsibility from a typed request, confirmed, run once, and a limit probe.
            void responsibilityAutopilot(runner, () => runnerState.current.zone, () => runnerState.current.sunday, debugRunner.fast);
          });
      } else {
        // The saved sign-in is checked once on launch, so automatic checks (and "check when Ozzie opens") can run.
        // Native code checks the church Ozzie last used whatever Settings name (a switch carried out just before a quit
        // included), and Settings then follow it (review S3, M1 and L1).
        void connection.status().then(async held => ({ held, verified: await verifySavedOnLaunch(merged(loadSettings()), held) }))
          .then(({ held, verified }) => {
            // What the check found, or what native already held when there was nothing to check: applied before the
            // launch check counts as done, so nothing says "not connected" in between (0.3.0 live click-through).
            const known = verified ?? held;
            if (known) {
              setStatus(known);
              // The scheduler reads this ref on its first tick, before React re-renders.
              current.current = { ...current.current, status: known };
            }
            launchCheckDone(false);
          }).catch(() => undefined).finally(() => { launchCheckDone(false); clearTimeout(waited); begin(); });
      }
    }).catch(() => { launchCheckDone(false); clearTimeout(waited); begin(); }).finally(() => setLaunched(true));
    return () => clearTimeout(waited);
  }, []);
  useEffect(() => saveRules(savedRules), [savedRules]);

  const brief = useMemo(() => capture ? buildSundayBrief(capture, rules, fictional ? capture.completed_at : now, fictional) : null, [capture, rules, now, fictional]);
  // "Looks good — I'll send it" marks (asked.ts, audit item 18): kept on this Mac by ids; dropped once the plan changes for
  // that person or the Sunday passes. Never part of the fictional example, and handed to the pages only as words and Undo.
  const [askedStore] = useState(() => askedMemory(browserStore, () => localDate(new Date().toISOString(), brief?.time_zone ?? macZone())));
  const [askedMarks, setAskedMarks] = useState<AskedMark[]>(() => askedStore.all());
  const liveBrief = brief && !fictional && brief.mode === "live" ? brief : null;
  useEffect(() => { if (liveBrief) setAskedMarks(askedStore.settle(liveBrief)); }, [liveBrief?.plan.id, liveBrief?.completed_at, askedStore]);
  const askedLines: AskedLine[] = holding(askedMarks, fictional ? null : brief).map(m => {
    const f = brief!.findings.find(x => x.key === m.key);
    return { key: m.key, person_id: m.person_id, text: askedText(m, capture?.names ?? {}, f?.position?.name ?? null), undo: () => setAskedMarks(askedStore.undo(m)) };
  });
  const askedSlot: AskedSlot = {
    lines: askedLines,
    onMark: (finding, person) => {
      const mark = brief && !fictional ? askedMark(brief, finding, person, new Date().toISOString()) : null;
      if (mark) setAskedMarks(askedStore.add(mark));
    },
  };
  // Someone looking at Ozzie sees a current picture: with the window on screen, a live check that has
  // gone out of date is read again (stale-refresh.ts). Paused checks stay paused.
  const lastRefresh = useRef(0);
  const refreshInput = { visible, fictional, ready: readiness === "ready", staleLive: Boolean(brief?.stale && capture?.kind === "live"),
    paused: automatic.schedule.paused, running: automatic.running };
  const mayRefresh = shouldRefreshStale({ ...refreshInput, nowMs: Date.parse(now), lastAttemptMs: lastRefresh.current });
  useEffect(() => {
    if (!mayRefresh) return;
    lastRefresh.current = Date.now();
    void proactive.checkNow("automatic").then(c => {
      if (!current.current.fictional) { setCapture(c); setNow(new Date().toISOString()); }
    }).catch(() => undefined);
  }, [mayRefresh]);
  const positions = useMemo(() => capture ? captureToCoverage(capture, rules, now).positions : [], [capture, rules, now]);
  const [decisions, setDecisions] = useSundayDecisions(capture, brief);
  // Rooms, follow-ups and group meetings from the capture's own reads, on the church's own time zone
  // (the example's fictional church is on Eastern time). A fictional example is evaluated as of its own check.
  const operations = useMemo(() => capture ? sundayOperations(capture, rules, fictional ? {} : { now }) : null, [capture, rules, now, fictional]);
  // One count everywhere: what the Sunday page shows (Services findings after decisions, plus rooms,
  // follow-ups and group meetings), for the sidebar badge, Today and the page's own headline.
  const open = brief ? sundayShownCount(applyDecisions(brief, decisions), operations) : null;
  const connected = (status?.state === "connected" || status?.state === "stored-unchecked") && Boolean(settings.organization) && status?.organization === settings.organization;
  const configured = /^\d+$/.test(settings.serviceTypeId) && /^\d+$/.test(settings.planId);
  const latest = recordings.filter(r => r.plan_id === settings.planId).sort((a, b) => b.completed_at.localeCompare(a.completed_at))[0];
  // The real day of the watched service, for every page (spec §5): from the check on screen when it is of the watched plan,
  // else from what was kept of that plan, else "your service". The example church meets on Sunday.
  const ofWatched = capture && brief && !fictional && capture.plan_id === settings.planId ? brief : null;
  useEffect(() => {
    if (ofWatched && capture) watchedDay.set(capture.plan_id, ofWatched.plan.sort_date, planTimes(capture.reads), ofWatched.time_zone);
  }, [ofWatched?.plan.id, ofWatched?.completed_at]);
  const day: DayWords = useMemo(() => {
    if (fictional && brief?.day) return brief.day;
    if (ofWatched?.day) return ofWatched.day;
    const kept = configured ? watchedDay.get(settings.planId) : null;
    return kept ? dayWords(kept, kept.zone) : UNKNOWN_WORDS;
  }, [fictional, brief?.day, ofWatched?.day, configured, settings.planId, watchVersion]);
  noticeDayRef.current = fictional ? undefined : noticeDayOf(day);
  // Moving on by itself (spec §5.3): once the watched plan's day has passed in the church's zone, Ozzie asks for that
  // service's next plan and watches it; with none planned yet, Today says so and it asks again each hour. A failed ask
  // keeps the plan it has and tries again a minute later.
  const [waitingLine, setWaitingLine] = useState<string | null>(null);
  // "Moved on to …" stays on Today for a day, across a relaunch (only the sentence and when; no names). What happened
  // can't hold it yet: its ledger takes only asks, jobs and checks (native ledger_admit), so this is said here (review L12).
  const [movedLine, setMovedLine] = useState<{ line: string; at: number } | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(MOVED_ON) ?? "null") as { line?: unknown; at?: unknown } | null;
      return v && typeof v.line === "string" && v.line.length <= 200 && typeof v.at === "number" && Date.now() - v.at < 86_400_000 ? { line: v.line, at: v.at } : null;
    } catch { return null; }
  });
  const moveAsked = useRef(0);
  useEffect(() => {
    if (!connected || !configured || fictional) return;
    const kept = watchedDay.get(settings.planId);
    const zone = ofWatched?.time_zone ?? kept?.zone ?? macZone();
    const watched: WatchedPlan = { serviceTypeId: settings.serviceTypeId, planId: settings.planId, sort_date: ofWatched?.plan.sort_date ?? kept?.sort_date ?? null,
      times: ofWatched && capture ? planTimes(capture.reads) : kept?.times ?? [], serviceName: kept?.service ?? null };
    if (!hasPassed(watched, zone, now)) { setWaitingLine(null); return; }
    if (Date.now() - moveAsked.current < (waitingLine ? WAIT_AGAIN_MS : 60_000)) return;
    moveAsked.current = Date.now();
    void moveOn(watched, zone, now, onboarding.nextPlan).then(r => {
      if (r.kind === "moved") {
        watchedDay.set(r.plan.id, r.plan.sort_date, r.plan.times, zone, watched.serviceName);
        setSettings(s => s.planId === watched.planId && s.serviceTypeId === watched.serviceTypeId ? { ...s, planId: r.plan.id } : s);
        const moved = { line: r.line, at: Date.now() };
        try { localStorage.setItem(MOVED_ON, JSON.stringify(moved)); } catch { /* per-device convenience only */ }
        setWaitingLine(null); setMovedLine(moved); setWatchVersion(v => v + 1);
        // Read the new plan as soon as Settings hold it (the checks read Settings as App renders).
        setTimeout(() => { void proactive.checkNow("automatic").then(c => { if (belongs(c)) { setCapture(c); setNow(new Date().toISOString()); } }).catch(() => undefined); }, 1000);
      } else if (r.kind === "waiting") setWaitingLine(r.line);
    }, () => undefined);
  }, [connected, configured, fictional, settings.planId, ofWatched?.plan.id, now.slice(0, 16)]);
  // No service chosen while connected (S5d, or first run left before choosing): Ozzie looks every hour, and picks by itself
  // when exactly one service has an upcoming plan; with several, Today's card asks; with none, it waits (review H2).
  const [serviceLook, setServiceLook] = useState<"several" | "waiting" | null>(null);
  const serviceLookAt = useRef(0);
  useEffect(() => {
    if (!connected || configured || fictional || !launched || (setup !== "auto" && setup !== null)) return;
    if (Date.now() - serviceLookAt.current < WAIT_AGAIN_MS) return;
    serviceLookAt.current = Date.now();
    void onboarding.pickService().then(pick => {
      const d = decideService(pick);
      if (d.kind === "one") {
        watchedDay.set(d.plan.id, d.plan.sort_date, d.plan.times, d.zone, d.service.name);
        setSettings(s => /^\d+$/u.test(s.planId) ? s : { ...s, serviceTypeId: d.service.id, planId: d.plan.id });
        setServiceLook(null); setWatchVersion(v => v + 1);
        setTimeout(() => { void proactive.checkNow("automatic").then(c => { if (belongs(c)) { setCapture(c); setNow(new Date().toISOString()); } }).catch(() => undefined); }, 1000);
      } else setServiceLook(d.kind === "several" ? "several" : "waiting");
    }, () => undefined);
  }, [connected, configured, fictional, launched, setup, now.slice(0, 16)]);
  // First run's result: the check on screen when it is of the plan just read, in the counts Today and the service's page use.
  const firstResult: ResultView | null = ofWatched && capture && open ? {
    brief: ofWatched, capture, counts: { decisions: open.decisions, looks: open.looks },
    lines: decisionLines(applyDecisions(ofWatched, decisions).items, { rooms: 0, followUps: 0 }, ofWatched.time_zone ?? macZone()).named,
  } : null;
  // Whether the church has Church rules for the first read to compare with (beyond the defaults every church starts with).
  const hasRules = rules.sundayLeads.length > 0 || Boolean(rules.kidsTeams?.length) || Boolean(rules.rooms?.length);
  // The teams of the check on screen (by id, named by their roles, as Church rules shows them), for the kids question.
  const teamsSeen = useMemo(() => [...new Map(positions.map(p => [p.team_id, positions.filter(x => x.team_id === p.team_id).map(x => x.name)])).entries()]
    .map(([id, roles]) => ({ id, name: [...new Set(roles)].join(" and ") || null })), [positions]);
  const markedKids = kidsTeams(rules).map(t => t.team_id);
  const momentsNow = moments.get();
  const kidsToAsk = !fictional && ofWatched ? kidsTeamToAsk(teamsSeen, markedKids, momentsNow) : null;
  // What else Ozzie can check with more of Planning Center (decision 24): after a check of the church's own service, while
  // the connection reads Services only (or holds the access with its reads off), until hidden. Native's switch is read
  // here for the church in use, and goes on here once a sign-in that asked for the access is granted (operations-reads.ts).
  const operationsReads = useOperationsReads(status);
  // A sign-in that only adds Calendar, People and Groups is in the browser (native says "waiting"): the church stays
  // connected meanwhile, so nothing offers to connect it, setup doesn't come back, and Today keeps its list.
  const addingAccess = operationsReads.asking && (status?.state === "waiting" || status?.state === "checking") && Boolean(org);
  // Any sign-in for a church already connected (Settings' "Connect again" included): the church in use stays in use until a
  // new sign-in replaces it, so the pages keep saying so, and its name, while it is in the browser or being checked (review
  // items 4 and 7). Words and what is shown only: checks still wait, and native decides everything as before. A first
  // connection has nothing to hold.
  const signingIn = status?.state === "waiting" || status?.state === "checking";
  const reconnecting = useHeldWhile(connected, signingIn) && signingIn && Boolean(org);
  const heldInUse = useHeldWhile(inUse, signingIn);
  const stillConnected = connected || addingAccess || reconnecting;
  // The church's last confirmed connection, for Settings while such a sign-in is under way, or after one ended (cancelled,
  // expired, refused) with that church back in use: "Connect again", its Connected line and its plans, with no need to press
  // "Check the connection" first (review item 7).
  const confirmed = useRef<ConnectionStatus | null>(null);
  if (status?.state === "connected") confirmed.current = status;
  // Gone once the saved sign-in itself is no longer confirmed (disconnected, or a check of it that failed or expired): a
  // sign-in started after that has no confirmed church to keep.
  else if (!status || status.state === "disconnected" || (["failed", "expired", "cancelled"].includes(status.state) && !status.last_attempt)) confirmed.current = null;
  const backInUse = status?.state === "stored-unchecked" && Boolean(status.last_attempt) && inUse?.organization === confirmed.current?.organization;
  const keptConnection = confirmed.current && confirmed.current.organization === org && (reconnecting || backInUse) ? confirmed.current : null;
  const moreNeed = readMoreNeed({ status, readsOn: operationsReads.on, checked: Boolean(ofWatched), hidden: readMoreMemory.hidden() });
  const moreOffered = useRef(false);
  if (moreNeed) moreOffered.current = true;
  const moreDone = moreNeed === null && operationsGranted(status) && operationsReads.on === true;
  const moreProps = { need: moreNeed, status, settings, onStatus: setStatus, church: inUse?.name ?? status?.organization_name ?? null };
  // "Finish setting up" (spec §4.1), from facts only.
  const finishFacts = {
    start: { asked: startAsked, on: startOn },
    // Nothing planned in any service yet: Ozzie waits and looks every hour; it doesn't ask to choose (review H2).
    service: { deferred: connected && !configured && serviceLook !== "waiting", watching: configured },
    kids: ofWatched ? kidsFacts(teamsSeen, markedKids, momentsNow) : { looking: false, answered: false },
    // "No AI for now" is an answer; only "Decide later" (or leaving the screen) keeps the item (review M1).
    ai: { left: aiStillOpen(setupMemo.get(), modelStatus, recordings.length > 0), chosen: modelStatus !== null && modelStatus.route !== "none" },
    plan: { waiting: Boolean(waitingLine) || (connected && !configured && serviceLook === "waiting"), found: false,
      service: watchedDay.get(settings.planId)?.service ?? null },
    // Kept while its sign-in is in the browser; once allowed, a check mark for the rest of this session, as the list keeps
    // done items.
    more: { offered: moreNeed !== null || (moreOffered.current && (addingAccess || moreDone)), done: moreDone },
  };
  // What Check my setup knows from the page (native's setup_check adds its own when it is built). The report never holds
  // the church, plan titles or people: their words are passed as `never`.
  const lastRun = automatic.schedule.last_run;
  const setupKnown = {
    connection: status, watched: configured ? { service: null, follows: true, date: day.date } : null, ai: modelStatus,
    aiCompany: modelStatus?.provider ?? null,
    lastCheck: lastRun ? { outcome: lastRun.outcome, at_ms: Date.parse(lastRun.finished_at) } : null,
    never: [...Object.values(capture?.names ?? {}), ...(status?.organization_name ? [status.organization_name] : []), ...(brief?.plan.title ? [brief.plan.title] : []),
      ...teamsSeen.flatMap(t => t.name ? [t.name] : [])],
  };

  // The harness reads the check on screen. Checking Planning Center again from inside an answer is the
  // same check as "Check Planning Center now" (recorded, never two at once), and the app then shows it.
  const latestState = useRef({ rules, decisions, status, configured: false });
  latestState.current = { rules, decisions, status, configured: Boolean(org && configured) };
  const refreshForHarness = useCallback(async function refresh(): Promise<HarnessData> {
    const c = await proactive.checkNow();
    if (!ofChurchInUse(c, current.current.settings.organization, current.current.inUseOrg)) throw "not-connected";
    const at = new Date().toISOString();
    setCapture(c); setFictional(false); setNow(at);
    const s = latestState.current;
    return buildHarnessData({ capture: c, fictional: false, rules: s.rules, decisions: s.decisions, status: s.status, configured: s.configured, now: at }, refresh);
  }, []);
  // Once the leader's own calendar is on Today, Ask no longer uses the fictional email import Today stopped showing.
  const fictionalImport = !calendarsConnected(calendarState);
  const harnessData = useMemo(() => buildHarnessData({
    capture, fictional, rules, decisions, status, configured: Boolean(org && configured), now, brief, operations, fictionalImport,
  }, refreshForHarness), [capture, fictional, rules, decisions, status, org, configured, now, brief, operations, fictionalImport, refreshForHarness]);
  const dataNow = useRef(harnessData);
  dataNow.current = harnessData;
  const workspace = org || "this-mac";
  const harness = useMemo(() => procedures
    ? createAppHarness({ workspace_id: workspace, data: dataNow.current, skills: procedures, session: harnessSession, loop, recorder }) : null,
  [procedures, workspace, loop, harnessSession, recorder]);
  useEffect(() => { harness?.update(harnessData); }, [harness, harnessData]);
  // "Use Ozzie's last check in other AI apps" (Settings): off unless the leader turns it on; only this church's check.
  const sharing = useSharing(harnessData, harnessSession, ledgerVersion, { organization: org, status });
  // "Let Siri and Shortcuts ask Ozzie" (Settings): off unless the leader turns it on; the same rule for which check.
  const shortcuts = useShortcuts(harnessData, harnessSession, { organization: org, status });
  const ask: AskFn | null = useMemo(() => harness && procedures
    ? (typed, signal) => askOzzie(harness, typed, { signal, recorder, skills: procedures, sender: yourName.get(), pausedWhen: pausedWhen(modelStatusRef.current?.account),
      local: modelStatusRef.current?.route === "local" })
      .finally(() => { void recorder.idle().then(() => setLedgerVersion(v => v + 1)); })
    : null, [harness, procedures, recorder]);
  // What happened reads the ledger when it opens, after each task, and every few seconds while it's open.
  useEffect(() => {
    if (page !== "activity") return;
    let alive = true;
    const load = () => {
      void recorder.list(50).then(rows => { if (alive) setTasks(rows); });
      void onboarding.ollamaHistory().then(h => { if (alive) setOllamaDone(h?.done ?? null); });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [page, ledgerVersion, recorder]);
  // "Ask Ozzie to look at who could help" on a Sunday card (audit item 9): the who-could-help procedure through the harness for
  // that one role, recorded in the task ledger like any task. Only while AI help is set up; the fixed list stays either way.
  const whoCouldHelp: WhoCouldHelp | undefined = useMemo(() => procedures && modelReady
    ? (finding, signal) => lookAtWhoCouldHelp(d => createAppHarness({ workspace_id: workspace, data: d, skills: procedures, session: harnessSession, loop, recorder }),
      dataNow.current, finding, { signal, recorder, skills: procedures, sender: yourName.get() })
      .finally(() => { void recorder.idle().then(() => setLedgerVersion(v => v + 1)); })
    : undefined, [procedures, modelReady, workspace, loop, recorder, harnessSession]);

  const act = async (work: () => Promise<SundayCapture>, isFictional = false) => {
    setBusy(true); setProblem(""); setRefused(false);
    try { setCapture(await work()); setFictional(isFictional); setNow(new Date().toISOString()); }
    catch (error) { setProblem(sundayProblem(error)); setRefused(refusedRead(error)); }
    finally { setBusy(false); }
  };
  // Same check as always (re-verify a saved connection, then read), through the one path that
  // never runs two checks at once and remembers what changed.
  const check = () => act(() => proactive.checkNow());
  // First run opens by itself only at launch, at the first unmet fact (spec §0.3): not connected, nothing watched, or no
  // result seen yet (no saved check of this church). Once launch, the status and the saved checks are known, it is
  // decided once; then it stays as the person leaves it, and opens again only from a button.
  const recordingsKnown = !org || recordingsFor === org;
  // The launch's check of this Mac's saved sign-in is under way for a church set up here: nothing says "not connected"
  // or offers Connect until it answers; the last saved check is shown meanwhile (0.3.0 live click-through).
  const checkingSaved = (!launchChecked || rechecking) && Boolean(org) && !fictional;
  // The launch check had no answer and nothing is known since: said, with "Check the connection" (review L6).
  const checkStuck = launchStuck && !checkingSaved && Boolean(org) && !fictional && status === null;
  const checkConnection = () => {
    setRechecking(true);
    const gaveUp = new Promise<null>(done => setTimeout(() => done(null), LAUNCH_WAIT_MS));
    void Promise.race([connection.refresh(settings.clientId, settings.organization, true).catch(() => null), gaveUp])
      .then(found => { if (found) setStatus(found); }).finally(() => setRechecking(false));
  };
  const savedShown = useRef(false);
  useEffect(() => {
    if (!checkingSaved || heldCapture || savedShown.current || !recordingsKnown) return;
    const saved = latest ?? recordings[0];
    if (!saved) return;
    savedShown.current = true;
    void sundaySource.loadRecording(org, saved.path_id)
      .then(c => { if (!current.current.fictional) setCapture(held => held ?? c); }).catch(() => undefined);
  }, [checkingSaved, recordingsKnown, recordings, heldCapture]);
  // A brand-new Mac (no church saved) shows the first screen at once: no page is drawn while that is being decided.
  const deciding = setup === "auto" && !org && !fictional;
  // A result counts as seen once a check of the watched plan is on screen, even before its saved copy is listed.
  const facts = { status, watching: Boolean(org && configured), resultSeen: recordings.length > 0 || Boolean(ofWatched), memory: setupMemo.get() };
  useEffect(() => {
    if (setup === "auto" && launched && launchChecked && statusRead && recordingsKnown) setSetup(firstRunScreen(facts));
  }, [setup, launched, launchChecked, statusRead, recordingsKnown]);
  const showSetup = setup !== "auto" && setup !== null;
  // Setup is unfinished while a required fact is unmet (once launch has decided): the sidebar's first entry leads back.
  const setupAt = setup === "auto" || fictional || addingAccess || reconnecting ? null : firstRunScreen(facts);
  // The sidebar's entry and the screen agree: it shows while setup is on screen (step 3's result included), and while a
  // required fact is unmet (0.3.0 live click-through).
  const setupEntry = showSetup || setupAt !== null;
  // A first result has been seen (a saved check of this church, or one on screen): AI and Ask come into view.
  const resultSeen = recordings.length > 0 || Boolean(ofWatched);
  // AI and Ask wait only while setup is on screen without a result: once a person leaves setup (Not now, the sidebar, the
  // example), they can reach both even if no result ever comes (re-check Low).
  const askShown = resultSeen || setup === null;
  /** Opens first run where it fits now: the browser step from Today, the first unmet fact elsewhere (the service once connected). */
  const openSetup = (at?: FirstRunScreen) => { setSetupKey(k => k + 1); setSetup(at ?? firstRunScreen(facts) ?? "service"); };
  // The first read is the same check as every other (recorded, one at a time), and its result is shown as the check on screen.
  const firstRead = useCallback(() => started.ready.then(() => proactive.checkNow()).then(c => {
    if (belongs(c)) { setCapture(c); setFictional(false); setNow(new Date().toISOString()); }
    return c;
  }), []);
  // A page an ozzie:// link opened (native accepts only Today and Sunday, while Siri and Shortcuts is on); ignored while
  // guided setup is showing, which a link never closes.
  const showingSetup = useRef(showSetup);
  showingSetup.current = showSetup;
  useOpenedPage(opened => { setFocusProcedure(null); setPage(opened); }, () => !showingSetup.current);
  useLayoutEffect(() => {
    // Opening a procedure, or a Sunday card from Today, moves to it instead.
    if (focusProcedure || sundayFocus) return;
    // So does Settings' AI help, after the AI screens were open over Settings.
    if (settingsAt) return;
    if (mainRef.current) mainRef.current.scrollTop = 0;
    if (typeof window !== "undefined" && typeof window.scrollTo === "function") window.scrollTo(0, 0);
  }, [page, showSetup, focusProcedure, aiChoosing, aiOpened]);
  const leaveSetup = (then: Page) => { setSetup(null); setPage(then); setStartAsked(startMemory.asked()); };
  // Whether Ozzie starts with this Mac, read when setup is closed (the debug probe never asks).
  useEffect(() => {
    if (setup !== null) return;
    let alive = true;
    void background.info().then(info => { if (!info.probe) autostart.get().then(on => { if (alive) setStartOn(on); }, () => undefined); });
    return () => { alive = false; };
  }, [setup]);
  // The fictional example (audit item 2): opened from setup, Today or Sunday; a band on every page says so while it is on.
  const showExample = () => { void act(() => Promise.resolve(withFictionalOperations(nov22Capture())), true); };
  const leaveExample = () => { setCapture(null); setFictional(false); setProblem(""); setRefused(false); };
  // The regular Sunday check as Today shows it (audit item 24): its schedule, last and next look, and what it missed today.
  // What quitting would stop or lose, told to native code as it changes: open cards (a count) and whether the regular
  // Sunday check or any job is on.
  useQuitGuard(openCards, { readiness, schedule: automatic.schedule, watch });
  // While a Planning Center sign-in is in the browser, checks wait so as not to cancel it, and the church in use is still
  // connected: Today says what was true before it started, never "Nothing runs yet" (review 2026-11-18).
  const shownReadiness = useHeldWhile(readiness, status?.state === "waiting" || status?.state === "checking");
  const regular: RegularCheck = {
    ready: shownReadiness === "ready", paused: automatic.schedule.paused, running: automatic.running || busy,
    intervalMinutes: automatic.prefs.intervalMinutes, runOnLaunch: automatic.prefs.runOnLaunch,
    last: automatic.schedule.last_run ? { at: automatic.schedule.last_run.finished_at, ok: automatic.schedule.last_run.outcome === "ok" } : null,
    next: automatic.schedule.next_run_at,
    missed: automatic.history.filter(e => e.kind === "missed" && e.scheduled_for && Date.parse(now) - Date.parse(e.at) < 86_400_000).map(e => e.scheduled_for!),
  };
  // Names for "What changed" come only from the current real check of the same organization.
  const changeNames = capture && !fictional && capture.organization === org ? capture.names : {};
  // The church's time zone as Planning Center Services gave it, from a real check of the same organization only.
  const churchZone = capture && !fictional && capture.organization === org ? brief?.time_zone ?? null : null;
  // Responsibilities follow the church's clock when a check has read it, otherwise this Mac's.
  const scheduleZone = churchZone ?? macZone();
  // The Sunday chosen in Settings, as a real check of it read it: "Keep an eye on Sunday" means that one.
  const chosenSunday = capture && !fictional && capture.organization === org && capture.plan_id === settings.planId ? brief?.plan.date ?? null : null;
  runnerState.current = {
    readiness, status, rules, decisions, modelReady, prefs: automatic.prefs, zone: scheduleZone, procedures, loop, workspace, capture, fictional,
    configured: Boolean(org && configured), sunday: chosenSunday,
  };
  const granted = grantedFor(fictional ? null : capture, false, status);
  const planContext: PlanContext = {
    // Words only (a plan card's "isn't connected yet"): held through a sign-in, as Today's regular check (review item 4); a
    // job started meanwhile says its first check waits for the sign-in, since none runs until then.
    organization: org, granted, modelReady, connected: shownReadiness === "ready", signingIn, zone: scheduleZone, now: () => new Date().toISOString(), sunday: chosenSunday,
    existing: watch.items, pausedAll: watch.paused_all, church: inUse?.name ?? null,
  };
  const planActions: PlanActions = {
    start: plan => runner.create(plan), edit: (id, plan) => runner.edit(id, plan),
    onSettings: () => { setSetup(null); setPage("connection"); }, onAutomatic: () => setPage("automatic"),
  };
  // What the person tells Ozzie on finding cards: kept with the Church rules, applied to the check on screen and every later one.
  const feedback: FeedbackSource = { entries: feedbackOf(rules), onEntries: next => setRules(r => ({ ...r, feedback: next })) };
  // "Keep an eye on Sunday" in Ask becomes a plan to confirm: read here, with no model.
  const plans: PlanHooks = { parse: typed => parseRequest(typed, new Date().toISOString(), scheduleZone, { sunday: chosenSunday }), context: planContext, actions: planActions };
  const dark = useDarkAppearance();
  // Closing Ask puts keyboard focus back on the button that opens it, rather than nowhere.
  const askEntry = useRef<HTMLButtonElement>(null);
  const closeAsk = () => { setAskOpen(false); askEntry.current?.focus(); };
  // A narrow window (or large text) shows the pages under Menu in a bar across the top, named as in the sidebar.
  const [menu, setMenu] = useState(false);
  // The AI screens over the page, from the sidebar's AI line and from every place that needs AI when none works (Ask,
  // rewording a note, the who-could-help look: walk-through, 2026-11-18). Their way back names the page under them.
  const chooseAi = () => { setMenu(false); setSetup(null); openAi(); };
  const menuButton = useRef<HTMLButtonElement>(null);
  const side = useRef<HTMLElement>(null);
  // While it's open, Escape (wherever the focus is: a click doesn't move it on a Mac) or a click outside closes it.
  useEffect(() => {
    if (!menu) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(false); menuButton.current?.focus(); } };
    const outside = (e: PointerEvent) => { if (!(e.target instanceof Node && side.current?.contains(e.target))) setMenu(false); };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); };
  }, [menu]);
  // Things to decide, the same number as Today's Sunday card and the Sunday page (Worth a look is listed there, not counted here).
  // Disconnected, the service's entry shows no count: nothing of the church is being kept an eye on (0.3.0 live).
  const sundayBadge = !fictional && status?.state === "disconnected" ? 0 : sundayCount(open);
  const automaticCount = page !== "automatic" ? automatic.unseen + watch.unseen : 0;
  // The sidebar keeps its words at every width (audit item 22c); a narrow window puts them under Menu, which Escape closes.
  // Its two lines (reads only; the church in use) go under Menu too, and the church stays in the bar (review F, L-6).
  // The church's name stays in the sidebar while a sign-in for it is in the browser (native names no church in use then).
  const shownChurch = inUse ?? (reconnecting || addingAccess ? heldInUse : null);
  const churchLine = checkingSaved && !connected ? CHECKING_LINE : checkStuck ? STUCK_LINE : !stillConnected ? "Planning Center not connected" : shownChurch?.name ? `Planning Center: ${shownChurch.name}` : "Planning Center connected";
  return <DayProvider value={day}><ChooseAiContext.Provider value={chooseAi}><div className={`oz app${dark ? " dark" : ""}`}>
    <div className={`shell ${askOpen ? "shell-ask" : "shell-2"}`}>
      <aside ref={side} className={`side${menu ? " is-menu" : ""}`}>
        <div className="brand"><img className="logo" src="/ozzie.svg" alt="Ozzie by FlockConnect" /></div>
        <button type="button" ref={menuButton} className="btn btn-secondary side-menu" aria-expanded={menu} aria-controls="side-nav"
          onClick={() => setMenu(!menu)}><Icon name="menu" />Menu</button>
        <p className="small side-bar-org">{churchLine}</p>
        <div id="side-nav" className="side-pages">
        <nav className="nav" aria-label="Pages">
          {/* While setup is unfinished, its own entry comes first: the way back to the screen it would open (review M11). */}
          {setupEntry && <a href="#setup" className="nav-i nav-setup" aria-current={showSetup ? "page" : undefined}
            onClick={e => { e.preventDefault(); setMenu(false); setAiChoosing(false); setChecking(false); if (!showSetup) openSetup(setupAt ?? undefined); }}>
            <Icon name="check" /><span className="nav-label">{SETTING_UP}</span></a>}
          {navFor(day).map(n => <a key={n.id} href={`#${n.id}`} className="nav-i" aria-current={!showSetup && page === n.id ? "page" : undefined}
          onClick={e => { e.preventDefault(); setMenu(false); if (showSetup) setSetup(null); setAiChoosing(false); setChecking(false); setFocusProcedure(null); setPage(n.id); }}><Icon name={n.icon} /><span className="nav-label">{n.label}</span>
          {n.id === "sunday" && sundayBadge > 0 && <span className="count"><span aria-hidden="true">{sundayBadge}</span>
            <span className="sr-only">, {sundayCountText(sundayBadge)}</span></span>}
          {n.id === "automatic" && automaticCount > 0 && <span className="count"><span aria-hidden="true">{automaticCount}</span>
            <span className="sr-only">, {automaticCount} new</span></span>}</a>)}</nav>
        <div className="side-foot">
          <p className="quiet-note"><Icon name="lock" small /><span className="nav-label">{promise("readsShort")} The names Ozzie reads stay on this Mac.</span></p>
          <p className="small side-org">{churchLine}</p>
          {/* AI and Ask wait for the first result: before it, nothing should pull a person off the one step that matters. */}
          {askShown && <div className="small side-ai"><AiLine status={modelStatus} small onChange={chooseAi} /></div>}
        </div>
        </div>
        {askShown && <button type="button" ref={askEntry} className="btn btn-secondary ask-entry" aria-expanded={askOpen} aria-controls="ask-panel"
          onClick={() => { setMenu(false); setAskOpen(!askOpen); }}><AskIcon /><span className="nav-label">Ask Ozzie</span></button>}
      </aside>
      <main className="main" ref={mainRef}>
        {showSetup && <FirstRun key={setupKey} start={setup} status={status} settings={settings} onSettings={setSettings} onStatus={setStatus}
          onWatching={(plan, zone, service) => { watchedDay.set(plan.id, plan.sort_date, plan.times, zone, service); setWatchVersion(v => v + 1); }}
          read={firstRead} result={firstResult} again={recordings.length > 0} rules={hasRules} intervalMinutes={automatic.prefs.intervalMinutes} nowMs={Date.parse(now)} memory={setupMemo}
          cards={openCards} onDiscardCards={discardCards} onLeave={to => leaveSetup(to)} onDeferred={() => setServiceDeferred(true)}
          renderAi={done => <AiChoice mode="first-run" onModel={setModelReady} onDone={how => done(how)} onCheckSetup={() => { done(); setChecking(true); }} />}
          onExample={() => { leaveSetup("sunday"); showExample(); }} />}
        {!showSetup && fictional && <ExampleBand onLeave={leaveExample} onSetUp={() => { leaveExample(); openSetup(); }} />}
        {!showSetup && aiChoosing && <div className="col"><AiFlow key={aiOpened} mode="settings" onModel={setModelReady} start={aiStart}
          backTo={backToName(page, day)}
          onDone={how => { if (how !== "later") setupMemo.set({ aiOffered: true, aiAnswer: how }); setAiChoosing(false); readModel(); if (page === "connection") setSettingsAt("ai-title"); }}
          onCheckSetup={() => { setAiChoosing(false); setChecking(true); }} /></div>}
        {!showSetup && !aiChoosing && checking && <div className="col">
          <CheckMySetup known={setupKnown} serviceTypeId={settings.serviceTypeId || undefined} planId={settings.planId || undefined}
            planDate={(ofWatched?.plan.date ?? watchedDay.get(settings.planId)?.sort_date?.slice(0, 10)) || undefined}
            onConnect={() => { setChecking(false); openSetup("browser"); }} onChooseService={() => { setChecking(false); openSetup("service"); }}
            onChangeAi={openAi} onOpenNotices={() => { void onboarding.openNoticeSettings().catch(() => { setChecking(false); setPage("connection"); }); }}
            onTurnOnStart={() => answerStart(true)} onPhone={() => { setChecking(false); setPage("connection"); }} onCheckAgain={readModel} zone={brief?.time_zone ?? macZone()} />
        </div>}
        {!showSetup && !aiChoosing && !checking && !deciding && <>
        {switchQuestion && page !== "connection" && <SwitchWaiting question={switchQuestion} onOpen={() => setPage("connection")} />}
        {page === "today" && <UpdateLine state={updateState} nowMs={Date.parse(now)} cards={openCards} />}
        {page === "today" && macEnded && <MacEndedLine progress={macEnded} onClose={() => setMacEnded(null)}
          onOpen={() => { setMacEnded(null); openAiAt({ at: "mac" }); }} />}
        {page === "today" && ollamaEnded && <OllamaEndedLine progress={ollamaEnded} onClose={() => setOllamaEnded(null)}
          onOpen={() => { setOllamaEnded(null); openAiAt({ at: "mac" }); }} />}
        {/* The fictional example is the whole of Today while it's on: its invented Sunday and email, and none of this Mac's
            own jobs, events or the regular check, so nothing of the church's sits under the example's band (audit item 2). */}
        {page === "today" && <TodayPage brief={brief} names={capture?.names} sundayDecisions={decisions} operations={operations} onSunday={() => setPage("sunday")}
          watch={fictional ? null : { view: watch, now, onAutomatic: () => setPage("automatic"), onOpen: setPage }} feedback={feedback} example={fictional} now={now}
          notConnected={!stillConnected && !fictional && !checkingSaved && !checkStuck ? { onConnect: () => openSetup("browser"), onExample: showExample } : null}
          checking={checkingSaved && !connected} stuck={checkStuck ? checkConnection : null}
          regular={fictional ? null : regular} asked={askedLines} onSundayCard={key => { setSundayFocus(key); setPage("sunday"); }}
          startQuestion={null}
          finish={!fictional && stillConnected ? <FinishSettingUp facts={finishFacts} startFailed={startFailed} onStartWithMac={answerStart}
            onChooseService={() => openSetup("service")} onKidsRules={() => setPage("rules")} onChooseAi={openAi}
            moreBody={<ReadMore {...moreProps} place="today" />} /> : undefined}
          waiting={fictional ? null : waitingLine ?? (connected && !configured && serviceLook === "waiting" ? waitingText(null) : null)}
          moment={fictional ? undefined : movedLine && Date.now() - movedLine.at < 86_400_000 ? <p className="banner" role="status"><Icon name="check" small /><span>{movedLine.line}</span></p>
            : phoneMomentNow(momentsNow.noticeSent, false) ? <PhoneMoment onSetUp={() => setPage("connection")} /> : undefined}
          church={<ChurchReadsToday capture={capture} rules={rules} names={capture?.names} feedback={feedback} now={now} />}
          calendar={!fictional && calendarsConnected(calendarState) ? { reads: calendarState.reads, reading: calendarState.reading, onSettings: () => setPage("connection") } : null} />}
        {page === "sunday" && <SundayPage brief={brief} names={capture?.names ?? {}} busy={busy} problem={problem} sender=""
          connected={connected} adding={addingAccess || reconnecting} configured={configured} hasRecording={Boolean(latest)} canReword={modelReady} checking={checkingSaved && !connected}
          stuck={checkStuck ? checkConnection : null}
          decisions={decisions} onDecisions={setDecisions} operations={operations}
          onCheck={() => { void check(); }}
          onRecording={() => { if (latest) void act(() => sundaySource.loadRecording(org, latest.path_id)); }}
          onExample={showExample}
          onLaterExample={fictional && capture?.completed_at === nov22Capture().completed_at
            ? () => { void act(() => Promise.resolve(withFictionalOperations(nov22LaterCapture())), true); } : undefined}
          whoCouldHelp={whoCouldHelp} feedback={feedback} onSettings={() => setPage("connection")} refused={refused} onSetUp={() => openSetup()}
          people={{ granted: operationsGranted(status), onAdd: () => setPage("connection") }} asked={askedSlot} focus={sundayFocus} onFocused={() => setSundayFocus(null)}
          openInPlanningCenter={fictional ? null : openInPlanningCenter} pane={mainRef}
          worthALook={kidsToAsk ? <KidsQuestion teamId={kidsToAsk.id} teamName={kidsToAsk.name ?? "This team"}
            onYes={id => setRules(r => markKidsTeam(r, id, kidsToAsk.name ?? ""))} /> : undefined}
          church={<CheckInsSunday capture={capture} rules={rules} names={capture?.names ?? {}} feedback={feedback} now={now} />}
          more={ofWatched && capture ? <ReadMore {...moreProps} place="service" reads={capture.reads} onCheck={() => { void check(); }} /> : undefined}
          beside={card => <ChurchOwnWords state={sourcesState} card={card} onOpen={target => { churchSources.focus(target); setPage("lists"); }} />} />}
        {page === "rules" && <RulesPage rules={rules} onChange={setRules} positions={positions} keptElsewhere={Object.entries(rulesByChurch.kept).map(([organization, k]) => ({ organization, ...(k.name ? { name: k.name } : {}) }))}
          leaders={capture ? teamLeaders(capture) : {}} names={capture?.names ?? {}} rooms={capture ? captureRooms(capture) : []}
          procedures={orderedProcedures} focus={focusProcedure} church={<ChurchReadsRules rules={rules} onChange={setRules} capture={capture} status={status} />} />}
        {page === "lists" && <ChurchListsPage sources={churchSources} positions={positions} />}
        {page === "automatic" && <ProactivePage view={automatic} names={changeNames} organization={org} planId={settings.planId} church={inUse?.name ?? null}
          readiness={readiness} shownReadiness={shownReadiness} busy={busy} now={now} churchTimeZone={churchZone}
          onCheckNow={() => { void check(); }} onPause={() => proactive.pause()} onResume={() => proactive.resume()} onPrefs={p => proactive.setPrefs(p)}
          responsibilities={regular => <ResponsibilityList view={watch} context={planContext} runner={runner} actions={planActions} sunday={regular} names={changeNames} />} />}
        {page === "activity" && <ActivityPage capture={capture} notGranted={(operationsAsked.get() || operationsReads.on === true) && Boolean(status?.scopes) && !operationsGranted(status)}
          tasks={tasks} procedures={procedures} trigger={triggers.get} end={triggers.end} found={triggers.found} ollama={ollamaDone} />}
        {page === "connection" && <ConnectionPage openAt={settingsAt} onOpenAt={() => setSettingsAt(null)} status={status} kept={keptConnection} settings={settings} onSettings={setSettings} onStatus={setStatus} cards={openCards} onDiscardCards={discardCards}
          recordingCount={recordings.length} onModel={setModelReady} onAiAnswer={how => setupMemo.set({ aiOffered: true, aiAnswer: how })} prefs={automatic.prefs}
          developer={debug ? { loop, onLoop: next => { devLoop.set(next); setLoop(next); } } : undefined}
          sharing={sharing.settings} siri={shortcuts.settings} updates={<UpdatesSection state={updateState} nowMs={Date.parse(now)} cards={openCards} />} calendars={<CalendarSettings calendars={calendars} />}
          onAutomatic={() => setPage("automatic")} onSetup={() => openSetup()} onCheckSetup={() => setChecking(true)} onLists={() => setPage("lists")} autostart={autostart}
          onDeleteRecordings={() => { sharing.forget(); shortcuts.forget(); runner.forgetAllWriteups(); if (org) void sundaySource.deleteRecordings(org).finally(() => { refreshRecordings(); if (capture?.kind === "recording") setCapture(null); }); }} />}
        </>}
        {/* Outside the pages above, so guided setup or another page never unmounts it: the cards end only as KeptCards
            says (cards-page.tsx), and names beside them come only from a check of the church in use. */}
        {(page === "cards" || cardsOpened) && <div hidden={showSetup || page !== "cards"} className="cards-kept">
          <KeptCards check={capture && { organization: capture.organization, names: capture.names }} example={fictional} inUse={inUseOrg ?? null} discarded={cardsDiscarded} onScreen={visible} onOpenCards={setOpenCards}
            disconnected={status?.state === "disconnected"} signInAgain={needsSignIn(status)} /></div>}
      </main>
      {quitAsk && <QuitQuestion ask={quitAsk} onKeep={() => { setQuitAsk(null); quitting.keep(); }} onQuit={() => { void quitting.quit().catch(() => setQuitAsk(null)); }} />}
      <AskPanel key={askChurch.current ?? "none"} open={askOpen} onClose={closeAsk} ask={ask} brief={brief} modelReady={modelReady} onOpen={setPage}
        connection={stillConnected ? "connected" : checkingSaved ? "checking" : checkStuck ? "unchecked" : "not-connected"}
        page={showSetup ? "setup" : page} plans={plans} />
    </div>
  </div></ChooseAiContext.Provider></DayProvider>;
}
