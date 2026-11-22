import { shouldRefreshStale } from "./stale-refresh.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  connection, followInUse, foundOrganization, fresher, needsSignIn, operationsAsked, operationsGranted, parseInUse, parseSwitchQuestion, pendingSettings, seenInUse, yourName,
  type ConnectionStatus,
} from "./connection.js";
import { adoptRules, loadRulesByChurch, moveRules, ofChurchInUse, onScreenCapture, rulesInUse, saveRulesByChurch } from "./church-in-use.js";
import { SwitchWaiting } from "./planning-center-forms.js";
import { CheckInsSunday, ChurchReadsRules, ChurchReadsToday } from "./church-reads-view.js";
import "./hearth.css";
import "./styles.css";
import { buildSundayBrief, roleWithService, sundayShownCount, teamLeaders, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { captureToCoverage, type PositionLabel, type SundayCapture, type SundayRules } from "../../../core/src/sunday-capture.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import { nov22Capture, nov22LaterCapture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { captureRooms, sundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, decisionsStorageKey, loadDecisions, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { CHECKING_LINE, PageControls, SERVICE_UNNAMED, STUCK_LINE, SundayPage, useDecisionsMap, useSundayDecisions, type WhoCouldHelp } from "./sunday-page.js";
import { addService, alsoWatched, movedOn, readDay, removeService, type AlsoWatched, type ServiceChoice } from "./watched-services.js";
import { alsoOperations, askServices, findingServices, firstRoomsWith, fromPartKey, harnessOperations, roomsHolders, partKey, mergeDecisions, mergedNames, mergeParts, MANY_SERVICES, otherOperations, teamServices,
  withOthers, type OtherPart } from "./services-merge.js";
import { acrossText, ServicesPage } from "./services-page.js";
import { AlsoOperationsContext, FindingServicesContext, serviceOfTeam as serviceOfTeamFor, TeamServicesContext } from "./team-labels.js";
import { WatchedServices } from "./watch-another.js";
import { RulesPage } from "./rules-page.js";
import { ActivityPage } from "./activity-page.js";
import { ConnectionPage } from "./connection-page.js";
import { TodayPage } from "./today-page.js";
import { sundayCount, sundayCountText } from "./today-groups.js";
import { Icon } from "./icons.js";
import { model } from "./model.js";
import { devChurchRules, devKidsRules, responsibilityAutopilot, runAutopilot } from "./autopilot.js";
import { loadRules, loadSettings, refusedRead, saveRules, saveSettings, sundayProblem, sundaySource, type RecordingSummary } from "./sunday-source.js";
import {
  browserStore, desktopProactive, proactiveReadiness, SystemReadFailure, verifySavedOnLaunch, type ProactiveHooks, type ProactivePrefs, type Readiness, type SystemWatch,
} from "./proactive.js";
import { desktopSystemProactive, systemReady } from "./system-watch.js";
import { ProactivePage, useProactiveView } from "./proactive-page.js";
import { AskIcon, AskPanel, settledRoles, type AskFn, type PlanHooks } from "./ask-panel.js";
import { rolePositions } from "../../../core/src/ask.js";
import type { Skill } from "../../../core/src/harness/contract.js";
import type { HarnessData } from "../../../core/src/harness/index.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { composeAnswer } from "../../../core/src/harness/compose.js";
import { parseRequest } from "../../../core/src/harness/responsibilities.js";
import {
  askOzzie, buildHarnessData, createAppHarness, desktopRecorder, devLoop, enableDebugLines, grantedFor, localTriggers, procedures as loadProcedures, systemHarnessCapture,
  keptWriteup, lookAtWhoCouldHelp, otherServiceData, PROCEDURE_ORDER, stepNotes, type LoopChoice,
} from "./harness-bridge.js";
import { modelSteps, type TaskRow } from "./harness-words.js";
import { KeptCards } from "./cards-page.js";
import { FirstRun, startMemory } from "./setup-flow.js";
import { aiStillOpen, firstRunScreen, isConnected, setupMemory, type FirstRunScreen } from "./first-run-state.js";
import { decideService, type ResultView } from "./your-service.js";
import { decisionLines, type RegularCheck } from "./today-groups.js";
import { DayProvider, dayWords, UNKNOWN_WORDS, type DayWords } from "./day-words.js";
import { BUILD_FORM, promise } from "./promises.js";
import { AiChoice, AiFlow, type AiStep } from "./ai-choice.js";
import { MacEndedLine, OllamaEndedLine, thisMacShown } from "./ai-this-mac.js";
import { AiLine, ChooseAiContext } from "./ai-line.js";
import { FinishSettingUp } from "./finish-list.js";
import { kidsFacts, kidsTeamToAsk, moments } from "./moments.js";
import { KidsQuestion, kidsTeamName, markKidsTeam } from "./kids-question.js";
import { ReadMore, readMoreMemory, readMoreNeed } from "./read-more.js";
import { useOperationsReads } from "./operations-reads.js";
import { PhoneMoment, phoneMomentNow } from "./phone-moment.js";
import { CheckMySetup } from "./check-setup.js";
import { hasPassed, moveOn, WAIT_AGAIN_MS, waitingText, type WatchedPlan } from "./move-on.js";
import { useBiggerTextKey } from "./text-size.js";
import { Announcer } from "./announce.js";
import { keepTitle, noticeDayOf } from "./day-phrases.js";
import { onboarding, type ModelProgress, type NoticeDay, type OllamaHistory, type OllamaProgress } from "./onboarding-bridge.js";
import { kidsTeams } from "../../../core/src/kids-rules.js";
import { pausedWhen, type ModelStatus } from "./model.js";
import { askedMark, askedMemory, askedText, holding, type AskedMark } from "./asked.js";
import type { AskedLine, AskedSlot, SundayChanges } from "./sunday-page.js";
import { localDate, planDate } from "../../../core/src/church-time.js";
import { longDate, planTimes } from "../../../core/src/service-day.js";
import { openInPlanningCenter } from "./planning-center-pages.js";
import { invoke } from "@tauri-apps/api/core";
import { autostart, background, quitting, startProbe } from "./background.js";
import { checksOn, QuitQuestion, useQuitGuard, type QuitAsk } from "./quit-question.js";
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
import {
  churchSystem, churchSystems, deleteChecksOrLater, isOtherSystem, keychainAsking, letGoAgain, NOT_CHOSEN, SystemWordsContext, systemWords, useKeychainAsking, type ChurchSystemState,
  type MainSystem,
} from "./church-system.js";
import { readSystem, useSystemChurch } from "./system-church.js";
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import { fictionalB1, fictionalBreeze } from "../../../core/src/church-systems/fictional.js";
import { GenesisFirstRun, GenesisPage, GenesisSettings, GenesisToday, GenesisWatch, genesisAnswer, genesisExample, genesisQuestions, useGenesisChurch } from "./genesis-church.js";
import { choiceLine, ChooseSystem, listedToday, soonest, SystemFirstRun, systemFirstRunAt, type SystemResultView } from "./system-setup.js";
import { GenesisAlsoRead, OtherSystems, SystemFactsList, SystemSettings } from "./system-settings.js";
import { ListsSystemName, ListsTeamServices } from "./church-notes.js";
import { refusalLine, SystemNotices } from "./system-pages.js";
import { ChangeHistory, ChangeResults, ChangesSwitch, filledByAdds, sundayChanges, useChanges } from "./change-card.js";
import { ACTIVITY_LEDE_ON, quitUndo, SETTINGS_BANNER_ON, SIDEBAR_ON } from "./planning-center-changes.js";

type Page = "today" | "sunday" | "cards" | "rules" | "lists" | "automatic" | "activity" | "connection";
/** The sidebar's pages. The services' own page is "Services", whatever day they are on (owner decision 2026-11-19). */
const navFor = (day: DayWords): { id: Page; label: string; icon: string }[] => [
  { id: "today", label: "Today", icon: "clock" }, { id: "sunday", label: day.page, icon: "sun" }, { id: "cards", label: "Visitor cards", icon: "user" },
  { id: "rules", label: "Church rules", icon: "rules" }, { id: "lists", label: "Church lists", icon: "table" },
  { id: "automatic", label: "Keeping watch", icon: "repeat" },
  { id: "activity", label: "What happened", icon: "history" }, { id: "connection", label: "Settings", icon: "sliders" },
];
/** A page named mid-sentence ("Back to Today", "Back to Services"): every page by its sidebar name. */
export const backToName = (page: Page, day: DayWords): string => navFor(day).find(n => n.id === page)?.label ?? "Today";
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
  /**
   * The watched service's own name, learnt where a list of services was read anyway (Settings' plan picker, Watch another
   * service), so the confirmation of an add and the Services page's parts name the first service too (review of
   * write-back-050, L1). What is kept of that plan's day stays; for another plan nothing else is known yet.
   */
  named(planId: string, service: string | null) {
    if (!service?.trim()) return;
    const kept = watchedDay.get(planId);
    watchedDay.set(planId, kept?.sort_date ?? null, kept?.times ?? [], kept?.zone ?? null, service.trim());
  },
};
const proactive = desktopProactive();
// A church on B1 Church or Breeze is kept watch over by its own schedule, beside Planning Center's (system-watch.ts).
const systemProactive = desktopSystemProactive();
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
/**
 * The visitor cards' church while the church uses another system: one name for all of it, so connecting again (even to
 * another church there) never ends open cards unasked; only a switch of system does, after its question says so.
 */
const SYSTEM_CARDS = "church-system";
/** A system check's roles as Church lists and the cards match them: the system's own ids, its role names, the service's time. */
const systemPositions = (c: SystemCapture): PositionLabel[] => c.positions.map(p => ({
  position_id: p.id, team_id: p.team_id ?? "?", name: Object.hasOwn(c.labels, `position:${p.id}`) ? c.labels[`position:${p.id}`]! : "A role without a name",
  interval: c.service?.ends_at ? { starts_at: c.service.starts_at, ends_at: c.service.ends_at } : null,
}));
/** The church on another system as its checks and saved Sundays are kept, `<system>:<church id>`; null otherwise. */
const onSystemKey = (state: ChurchSystemState): string | null =>
  isOtherSystem(state.main) && state.connection ? `${state.connection.system}:${state.connection.church_id}` : null;
/** This Mac's date, YYYY-MM-DD: a system's service day is the system's own calendar day, compared with it. */
const macToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
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

/**
 * The narrowest window, in CSS pixels, where Ask docks beside the page instead of lying over it (styles.css has the same
 * width): the sidebar's 304px, Ask's 380px and the 596px the page keeps in the smallest window (900px). The default
 * 1280-point window docks; zoomed text (View › Bigger Text) narrows the CSS width and Ask goes back over the page.
 */
export const ASK_DOCKS_AT = 1280;
/** Whether Ask docks beside the page now, live (the window resized or the text size changed). Without a window, it does. */
function useAskDocked(): boolean {
  const query = () => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(`(min-width: ${ASK_DOCKS_AT}px)`) : null;
  const [docked, setDocked] = useState(() => query()?.matches ?? true);
  useEffect(() => {
    const q = query();
    if (!q) return;
    const changed = () => setDocked(q.matches);
    changed();
    q.addEventListener?.("change", changed);
    return () => q.removeEventListener?.("change", changed);
  }, []);
  return docked;
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
export const EXAMPLE_BAND = { title: "Example church, not real.", body: "The service, teams, people and email shown are made up. Your own Church rules, lists, settings and visitor cards are real.",
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
  // The other services Ozzie watches (watched-services.ts, owner decision 2026-11-19), kept per church, and what the latest
  // round read of each (by plan), or why it couldn't, or that no next plan exists yet. Planning Center only.
  const [alsoStore] = useState(() => alsoWatched(browserStore));
  const [alsoKept, setAlsoList] = useState<AlsoWatched[]>(() => alsoStore.get(loadSettings().organization));
  // Never the service Settings watches first (Settings' picker can choose one that was also watched): it is read once.
  const also = useMemo(() => alsoKept.filter(s => s.serviceTypeId !== settings.serviceTypeId), [alsoKept, settings.serviceTypeId]);
  const [alsoCaptures, setAlsoCaptures] = useState<Readonly<Record<string, SundayCapture>>>({});
  const [alsoProblems, setAlsoProblems] = useState<Readonly<Record<string, string>>>({});
  const [alsoWaiting, setAlsoWaiting] = useState<Readonly<Record<string, string>>>({});
  // The same, for checks and jobs that read them between renders (the round's hook keeps the captures here first).
  const alsoNow = useRef({ also, captures: alsoCaptures as Readonly<Record<string, SundayCapture>> });
  alsoNow.current.also = also;
  /** The first service's latest live check, kept as soon as a round reads it, for which service shows a day's rooms. */
  const mainNow = useRef<SundayCapture | null>(null);
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
  // A church on B1 Church or Breeze (decision 21): its connection, last check and brief (system-church.ts). Planning
  // Center's own state below is untouched; where a page needs the service check, it reads `onSystem` first.
  const feedbackEntries = useMemo(() => feedbackOf(rules), [rules]);
  // Every check of it goes through its schedule, once launch has settled (one at a time, recorded in What happened).
  const systemCheckNow = useCallback(() => started.ready.then(() => systemProactive.checkNow()), [started]);
  const sys = useSystemChurch(now, feedbackEntries, systemCheckNow);
  const sysNow = useRef(sys);
  sysNow.current = sys;
  // The church on another system, as its checks and saved Sundays are kept: `<system>:<church id>`.
  const systemChurchKey = onSystemKey(sys.state);
  // Once that church is let go (a disconnect, a switch, another church connected), nothing about it is told afterwards:
  // a notice held for quiet hours is dropped (its checks already stop, since each reads the connection kept now).
  const watchedChurch = useRef(systemChurchKey);
  useEffect(() => {
    if (watchedChurch.current && watchedChurch.current !== systemChurchKey) systemProactive.letGo();
    watchedChurch.current = systemChurchKey;
  }, [systemChurchKey]);
  // Leaving Planning Center for another system: a notice it held about the church signed out of is dropped (review L9).
  const mainBefore = useRef(sys.state.main);
  useEffect(() => {
    if (mainBefore.current === "planning-center" && sys.state.main !== null && sys.state.main !== "planning-center") proactive.letGo();
    mainBefore.current = sys.state.main;
  }, [sys.state.main]);
  // A key Ozzie let go of that this Mac's Keychain didn't let it remove then (church-system.ts letGoLater): tried again
  // when Ozzie starts and whenever the church connected changes, never the one in use.
  useEffect(() => { void letGoAgain(churchSystem.get()); }, [systemChurchKey]);
  const onSystem = sys.on;
  // A church whose main system is Genesis (round 5): no service to check; what Genesis shares, read on its own schedule.
  const onGenesis = sys.state.main === "genesis";
  // Planning Center's state is kept off any other main system: B1 Church, Breeze or Genesis (review of e9cbd97d, H2).
  const offPc = Boolean(onSystem) || onGenesis;
  const words = systemWords(sys.state.main);
  // A church on another system: what the service's page, Today and Check my setup work from.
  const systemConnected = Boolean(sys.connection), systemConfigured = Boolean(sys.connection?.service_id);
  // The church Ozzie last used, kept while the church in use drops out for a moment (a Keychain write): Ask's answers
  // belong to it, and start afresh with another church (review S2, L2).
  const askChurch = useRef<string | undefined>(undefined);
  if (inUseOrg) askChurch.current = inUseOrg;
  const org = /^[1-9]\d{0,31}$/.test(settings.organization) ? settings.organization : "";
  // The list follows the church in Settings: another church's is never read, and what was read of the last one goes.
  const alsoOrg = useRef(org);
  alsoOrg.current = org;
  const listedFor = useRef(loadSettings().organization);
  useEffect(() => {
    if (listedFor.current === org) return;
    listedFor.current = org;
    alsoNow.current.captures = {};
    setAlsoList(alsoStore.get(org)); setAlsoCaptures({}); setAlsoProblems({}); setAlsoWaiting({});
  }, [org, alsoStore]);
  const setAlso = useCallback((change: (list: AlsoWatched[]) => AlsoWatched[]) => setAlsoList(list => {
    const next = change(list);
    if (next !== list) alsoStore.set(alsoOrg.current, next);
    return next;
  }), [alsoStore]);
  // The first service changed to one also watched: it is the first one now, and its saved checks and decisions stay.
  useEffect(() => {
    if (alsoKept.some(s => s.serviceTypeId === settings.serviceTypeId)) setAlso(list => list.filter(s => s.serviceTypeId !== settings.serviceTypeId));
  }, [alsoKept, settings.serviceTypeId, setAlso]);
  // "Choose again" from another system's setup, on a Mac that once used Planning Center (its settings still name the
  // church): nothing is chosen now, so the pages speak neutrally too (release review L3).
  const [choseAgain, setChoseAgain] = useState(false);
  // A fresh Mac that hasn't said what its church uses, nor connected Planning Center (round 5): every page speaks neutrally
  // and leads to "What does your church use?".
  // "Use a different system" is kept across a quit (church-system.ts `choosing`): the next launch still chooses.
  const nothingChosen = sys.state.main === null && !isConnected(status) && (!org || choseAgain || sys.state.choosing === true);
  // Nothing read from another church is shown or used: the check on screen must be this church's (church-in-use.ts),
  // and a check of a church Ozzie no longer uses is let go.
  // A church on B1 Church or Breeze has no Planning Center check on screen: a saved one from before a switch is never
  // shown beside its own (rooms, check-ins, names on visitor cards, what is shared with other apps).
  const capture = offPc ? null : onScreenCapture(heldCapture, fictional, org, inUseOrg);
  // The live check on screen, when it is the newest of the first service's plan this Mac has (never the example).
  if (capture && !fictional && capture.kind === "live" && capture.plan_id === settings.planId
    && (mainNow.current?.plan_id !== capture.plan_id || capture.completed_at >= mainNow.current.completed_at)) mainNow.current = capture;
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
  const current = useRef({ settings, rules, status, fictional, refreshRecordings, inUseOrg, also: [] as { serviceTypeId: string; planId: string }[],
    holdsRooms: ((): boolean => true) as (c: SundayCapture, now: string) => boolean });
  // Whether the church uses another system, from what this Mac keeps (not render state), so Planning Center's scheduled
  // checks and jobs see no connection from their very first tick at launch (final review H1).
  const onSystemNow = useRef(isOtherSystem(churchSystem.get().main) || churchSystem.get().main === "genesis");
  onSystemNow.current = offPc;
  const noticeDayRef = useRef<NoticeDay | undefined>(undefined);
  // A church on another system: Planning Center's scheduled checks and jobs see no connection, so none runs (review M1).
  // The other services watched are read in the same round (Planning Center only; never beside the example).
  current.current = { settings, rules, status: offPc ? null : status, fictional, refreshRecordings, inUseOrg,
    also: offPc || fictional ? [] : also.map(s => ({ serviceTypeId: s.serviceTypeId, planId: s.planId })),
    // Which service's check compares and tells a day's rooms: the page's own choice (services-merge.ts roomsHolders) over
    // every watched service's latest check, the one just read in its place. Always with one service.
    holdsRooms: (c, at) => {
      const { also: list, captures } = alsoNow.current, orgNow = current.current.settings.organization, planNow = current.current.settings.planId;
      const latest = (s: { planId: string; serviceTypeId: string }) => { const x = captures[s.planId]; return x && x.organization === orgNow && x.service_type_id === s.serviceTypeId ? x : null; };
      const checks = [c.plan_id === planNow ? c : mainNow.current?.plan_id === planNow ? mainNow.current : null, ...list.map(s => s.planId === c.plan_id ? c : latest(s))];
      const i = checks.indexOf(c);
      return i < 0 || roomsHolders(checks, current.current.rules, at)[i] === i;
    } };
  // A live check is acted on only if it is of the church Ozzie uses now: one that finishes, or is shared, after a switch
  // is dropped by every consumer (review S2, L1).
  const belongs = (c: SundayCapture) => ofChurchInUse(c, current.current.settings.organization, current.current.inUseOrg);
  const pcAutomatic = useProactiveView(proactive);
  const systemAutomatic = useProactiveView(systemProactive);
  // Keeping watch shows the schedule of the church's own system.
  // On Genesis it is the church systems' schedule too, which never runs there: Planning Center's history isn't counted.
  const automatic = offPc ? systemAutomatic : pcAutomatic;
  // Genesis: read on opening and on the person's interval while Ozzie is open (never while everything is paused), each read
  // recorded for What happened; the first that works marks its result seen (review of e9cbd97d, M6).
  const genesis = useGenesisChurch({ state: sys.state, on: onGenesis, intervalMinutes: automatic.prefs.intervalMinutes, paused: automatic.schedule.paused,
    now: () => new Date().toISOString(), record: (work, trigger) => recorder.checkSystem(work, "genesis", trigger),
    onSeen: church => { const kept = churchSystem.get(); if (kept.main === "genesis" && kept.genesis?.church_id === church && !kept.genesis.result_seen) sys.setState({ ...kept, genesis: { ...kept.genesis, result_seen: true } }); } });
  const genesisExampleShown = useMemo(() => onGenesis ? genesisExample() : null, [onGenesis]);
  // What the Genesis pages show: the fictional example church while it is on, else the last read.
  const genesisShown = fictional && genesisExampleShown ? genesisExampleShown : { capture: genesis.capture, view: genesis.view };
  const hooks: ProactiveHooks = useMemo(() => ({
    // The notice names the watched service's real day (a closed code, never text: spec §5.2, contract N8).
    context: () => ({ ...current.current, ...(onSystemNow.current ? { status: null } : {}), ...(noticeDayRef.current ? { noticeDay: noticeDayRef.current } : {}) }),
    onStatus: setStatus,
    onCapture: (c, trigger) => {
      // Responsibilities due soon share this check rather than reading Planning Center again.
      if (belongs(c)) runner.captured(c);
      if (belongs(c) && c.kind === "live") mainNow.current = c;
      current.current.refreshRecordings();
      void desktopRecorder().idle().then(() => setLedgerVersion(v => v + 1));
      // A scheduled check shows its result unless the person is looking at the fictional example.
      if (trigger !== "manual" && !current.current.fictional) { setCapture(c); setNow(new Date().toISOString()); }
    },
    // Something got worse: Keep Sunday covered may check sooner, and then sends the one notice about it.
    onChanges: handChanges(runner),
    // One of the other services watched, read in the same round: kept by its plan while that service is still watched and
    // it is of the church in use (never beside the example), with what it read of its day for the page and moving on.
    onAlsoCapture: c => {
      if (!belongs(c) || current.current.fictional || !alsoNow.current.also.some(s => s.planId === c.plan_id && s.serviceTypeId === c.service_type_id)) return;
      alsoNow.current.captures = { ...alsoNow.current.captures, [c.plan_id]: c };
      setAlsoCaptures(alsoNow.current.captures);
      setAlsoProblems(p => Object.hasOwn(p, c.plan_id) ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== c.plan_id)) : p);
      const read = buildSundayBrief(c, current.current.rules, new Date().toISOString());
      setAlso(list => readDay(list, c.plan_id, read.plan.sort_date, read.times ?? [], read.time_zone));
      setNow(new Date().toISOString());
    },
    // A check of one of them that brought nothing: its own part of the page says why, in fixed words.
    onAlsoFailure: (planId, error) => setAlsoProblems(p => ({ ...p, [planId]: sundayProblem(error) })),
    // One that ended after the leader stopped watching it: the copy native saved as it ended is deleted too, so nothing of
    // it stays, as the question said. Never the first service's plan.
    onAlsoDropped: c => {
      if (c.plan_id !== current.current.settings.planId) void sundaySource.deletePlanRecordings(c.organization, [c.plan_id]).catch(() => undefined);
    },
  }), []);
  // A church on B1 Church or Breeze: the connection this Mac keeps when each check starts (never render state), and the
  // read of its watched service, moving on first once its day has passed (systemRead below).
  const systemRead = useRef<() => Promise<SystemCapture>>(() => Promise.reject(new SystemReadFailure("b1", "unavailable")));
  const watchNow = (): SystemWatch | null => {
    const held = churchSystem.get();
    return isOtherSystem(held.main) && held.connection ? { connection: held.connection, read: () => systemRead.current() } : null;
  };
  const systemHooks: ProactiveHooks<SystemCapture> = useMemo(() => ({
    // Planning Center's connection is never part of it; the notice names the watched service's real day (a closed code).
    context: () => ({ ...current.current, status: null, system: watchNow(), also: [], ...(noticeDayRef.current ? { noticeDay: noticeDayRef.current } : {}) }),
    onStatus: () => undefined,
    onCapture: c => {
      // Kept only when it is of the church and service watched now (system-church.ts `take`).
      sysNow.current.take(c);
      void desktopRecorder().idle().then(() => setLedgerVersion(v => v + 1));
      setNow(new Date().toISOString());
    },
    // A check on its own that brought nothing says why on the service's page, as Check now does (a key no longer accepted).
    onFailure: (error, trigger) => {
      if (trigger !== "manual") sysNow.current.fail(error);
      void desktopRecorder().idle().then(() => setLedgerVersion(v => v + 1));
    },
  }), []);
  useEffect(() => () => { proactive.stop(); systemProactive.stop(); }, []);
  // Seen in Ozzie only while the window is on screen: with it closed, Ozzie keeps running in the menu bar.
  const visible = useWindowVisible();
  useEffect(() => { if (page === "automatic" && visible) (offPc ? systemProactive : proactive).markSeen(); }, [page, automatic.unseen, visible, offPc]);
  useEffect(() => { if (page === "cards") setCardsOpened(true); }, [page]);
  // Run a due check as soon as a saved connection and a chosen Sunday are known, not at the next timer tick.
  const readiness = proactiveReadiness(settings, offPc ? null : status);
  useEffect(() => { if (readiness === "ready") { void proactive.tick(); void runner.tick(); } }, [readiness]);
  // The same for a church on another system, as soon as its service and first result are known.
  const systemWatchReady = systemReady(onSystem && sys.connection ? { connection: sys.connection, read: () => systemRead.current() } : null);
  useEffect(() => { if (systemWatchReady) void systemProactive.tick(); }, [systemWatchReady]);
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
  /**
   * The other services' latest checks as a count across services needs them between renders (a job's run, Ask checking
   * again): each one's brief, its own rooms and group meetings (beside `main`, the first service's check, for which
   * service holds a day's rooms: services-merge.ts otherOperations) and the leader's decisions kept on this Mac, of the
   * church in use only, never beside the example or for a church on another system.
   */
  const othersNow = (at: string, main: SundayCapture | null): { parts: OtherPart[]; captures: SundayCapture[] } => {
    if (current.current.fictional || onSystemNow.current) return { parts: [], captures: [] };
    const { also: list, captures } = alsoNow.current;
    const orgNow = current.current.settings.organization, rulesNow = current.current.rules;
    const caps = list.flatMap(s => { const c = captures[s.planId]; return c && c.organization === orgNow && c.service_type_id === s.serviceTypeId ? [c] : []; });
    const ops = otherOperations(main, caps, rulesNow, { now: at });
    return { captures: caps, parts: caps.map((c, i) => {
      const b = buildSundayBrief(c, rulesNow, at);
      let d: SundayDecision[] = [];
      try { d = loadDecisions(localStorage, decisionsStorageKey(b.mode, c.organization, c.plan_id)); } catch { /* none kept */ }
      return { plan_id: c.plan_id, brief: b, decisions: d, operations: ops[i]?.operations ?? null, roomsWith: ops[i]?.roomsWith ?? null };
    }) };
  };
  /**
   * What Ask's check again and a job's AI write-up read: a fresh check of the first service with every other service watched,
   * as the page shows them (merged brief, names on this Mac, each role's service), never only the first one.
   */
  const mergedHarness = (c: SundayCapture, at: string, own: { rules: SundayRules; decisions: readonly SundayDecision[]; status: ConnectionStatus | null; configured: boolean },
    refresh?: HarnessData["refresh"]): HarnessData => {
    const more = othersNow(at, c);
    const first = buildSundayBrief(c, own.rules, at);
    const mainRooms = firstRoomsWith(c, more.captures, own.rules, at) === null;
    const m = mergeParts({ brief: first, decisions: own.decisions }, more.parts);
    const mainName = watchedDay.get(current.current.settings.planId)?.service ?? null;
    const named = more.parts.map(p => ({ plan_id: p.plan_id, brief: p.brief, name: alsoNow.current.also.find(x => x.planId === p.plan_id)?.name ?? null }));
    const teams = teamServices({ brief: first, name: mainName }, named);
    // A question may name any service watched; its name becomes a label, never sent (core ask.ts PrepareOptions `services`).
    const asked = askServices({ brief: first, name: mainName }, named,
      alsoNow.current.also.filter(x => !more.parts.some(p => p.plan_id === x.planId)).map(x => x.name));
    return buildHarnessData({ capture: mergedNames(c, more.captures), fictional: false, rules: own.rules, decisions: m.decisions, status: own.status, configured: own.configured,
      now: at, brief: m.brief, operations: sundayOperations(c, own.rules, { now: at, ...(mainRooms ? {} : { rooms: false }) }), serviceOfTeam: teams, ...asked,
      // Each other service's own rooms and group meetings, by its name, for a question about it (core harness tools.ts).
      alsoOperations: harnessOperations(named.map((p, i) => ({ ...p, operations: more.parts[i]?.operations ?? null, roomsWith: more.parts[i]?.roomsWith ?? null }))) }, refresh);
  };
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
        // The other services watched, as the Services page shows them (read in the same round as the run's check), each with
        // its own rooms and group meetings beside the run's check of the first service, which may leave its day's rooms to one.
        alsoServices: main => {
          const { parts, captures } = othersNow(new Date().toISOString(), main);
          return parts.length ? { firstRooms: firstRoomsWith(main, captures, current.current.rules, new Date().toISOString()) === null,
            others: parts.map(p => ({ plan_id: p.plan_id, brief: p.brief, decisions: p.decisions, operations: p.operations ?? null })) } : null;
        },
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
      // Every service watched, as the job's count says them (owner decision 2026-11-19).
      const data = mergedHarness(c, new Date().toISOString(), s);
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
      tick: () => { void runner.tick(); void proactive.tick(); void systemProactive.tick(); },
      wake: (slept, at) => runner.wake(slept, at),
      // Pause everything takes effect at once; lifting it puts the Sunday check back as it was.
      paused: paused => { proactive.pauseWithEverything(paused); systemProactive.pauseWithEverything(paused); void runner.pausedElsewhere(paused); },
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
    const begin = () => { if (begun) return; begun = true; proactive.start(hooks); systemProactive.start(systemHooks); runner.start(runnerHooks); started.resolve(); };
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
        void connection.status().then(async held => ({ held,
          // A church on another system: its saved Planning Center sign-in (if one survived a switch) isn't renewed or used.
          verified: onSystemNow.current ? null : await verifySavedOnLaunch(merged(loadSettings()), held) }))
          .then(({ held, verified }) => {
            // What the check found, or what native already held when there was nothing to check: applied before the
            // launch check counts as done, so nothing says "not connected" in between (0.3.0 live click-through).
            const known = verified ?? held;
            if (known) {
              setStatus(known);
              // The scheduler reads this ref on its first tick, before React re-renders (its context hides it on another system).
              current.current = { ...current.current, status: onSystemNow.current ? null : known };
            }
            launchCheckDone(false);
          }).catch(() => undefined).finally(() => { launchCheckDone(false); clearTimeout(waited); begin(); });
      }
    }).catch(() => { launchCheckDone(false); clearTimeout(waited); begin(); }).finally(() => setLaunched(true));
    return () => clearTimeout(waited);
  }, []);
  useEffect(() => saveRules(savedRules), [savedRules]);

  const pcBrief = useMemo(() => capture ? buildSundayBrief(capture, rules, fictional ? capture.completed_at : now, fictional) : null, [capture, rules, now, fictional]);
  // A church on another system: the brief from its own check, or its own fictional example church (fictional.ts).
  const systemShown = Boolean(onSystem) && !fictional;
  const systemExample = useMemo(() => {
    if (!onSystem || !fictional) return null;
    const example = onSystem === "b1" ? fictionalB1() : fictionalBreeze();
    const built = buildSystemBrief(example, { confirmedZone: example.church.time_zone }, now, { fictional: true });
    return built.ok ? { capture: example, brief: built.brief } : null;
  }, [onSystem, fictional]);
  const brief = onSystem ? (fictional ? systemExample?.brief ?? null : sys.built?.brief ?? null) : pcBrief;
  // The names the pages resolve, from the check on screen (Planning Center's, or the other system's).
  const shownNames = onSystem ? (fictional ? systemExample?.capture.names : sys.capture?.names) : capture?.names;
  // "Looks good — I'll send it" marks (asked.ts, audit item 18): kept on this Mac by ids; dropped once the plan changes for
  // that person or the Sunday passes. Never part of the fictional example, and handed to the pages only as words and Undo.
  const [askedStore] = useState(() => askedMemory(browserStore, () => localDate(new Date().toISOString(), brief?.time_zone ?? macZone())));
  const [askedMarks, setAskedMarks] = useState<AskedMark[]>(() => askedStore.all());
  const liveBrief = brief && !fictional && brief.mode === "live" ? brief : null;
  useEffect(() => { if (liveBrief) setAskedMarks(askedStore.settle(liveBrief)); }, [liveBrief?.plan.id, liveBrief?.completed_at, askedStore]);
  /**
   * One service's marks as a page shows them: those still holding for that service's own check (each is kept by its own
   * plan, so another service's never shows, even on a role of the same name), with Undo; the role said with `service` when
   * one is given (Today, with several services watched).
   */
  const askedLinesFor = (b: SundayBrief | null, names: Readonly<Record<string, string>>, service: string | null = null): AskedLine[] => holding(askedMarks, b).map(m => {
    const role = b!.findings.find(x => x.key === m.key)?.position?.name ?? null;
    return { key: m.key, person_id: m.person_id, text: askedText(m, names, role === null ? null : roleWithService(role, service)), undo: () => setAskedMarks(askedStore.undo(m)) };
  });
  /** The leader's own click on a note in one service's part, marked on that service's plan (never beside the example). */
  const askedSlotFor = (b: SundayBrief | null, lines: readonly AskedLine[]): AskedSlot => ({
    lines,
    onMark: (finding, person) => {
      const mark = b && !fictional ? askedMark(b, finding, person, new Date().toISOString()) : null;
      if (mark) setAskedMarks(askedStore.add(mark));
    },
  });
  const askedLines: AskedLine[] = askedLinesFor(fictional ? null : brief, shownNames ?? {});
  const askedSlot: AskedSlot = askedSlotFor(brief, askedLines);
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
  // The same for a church on another system: its live check gone out of date, read again (never a saved copy shown on request).
  const lastSystemRefresh = useRef(0);
  const maySystemRefresh = shouldRefreshStale({ visible, fictional, ready: systemWatchReady, staleLive: Boolean(onSystem && sys.built?.brief.stale && !sys.saved),
    paused: systemAutomatic.schedule.paused, running: systemAutomatic.running, nowMs: Date.parse(now), lastAttemptMs: lastSystemRefresh.current });
  useEffect(() => {
    if (!maySystemRefresh) return;
    lastSystemRefresh.current = Date.now();
    void systemProactive.checkNow("automatic").catch(() => undefined);
  }, [maySystemRefresh]);
  const [decisions, setDecisions] = useSundayDecisions(onSystem ? (fictional ? systemExample && { organization: `example:${onSystem}`, plan_id: systemExample.brief.plan.id } : sys.decisionsKey) : capture, brief);
  // Each other service watched, from its latest check while it is still watched and of the church in use, with the leader's
  // own decisions for it; never beside the example or for a church on another system.
  // Its checks, of the church in Settings and in use (a switch under way shows none of the church before it).
  const alsoShownCaptures = useMemo(() => offPc || fictional ? [] : also.flatMap(s => {
    const c = alsoCaptures[s.planId];
    return c && c.organization === org && (inUseOrg === undefined || c.organization === inUseOrg) && c.service_type_id === s.serviceTypeId ? [{ service: s, capture: c }] : [];
  }), [also, alsoCaptures, offPc, fictional, org, inUseOrg]);
  const alsoParts = useMemo(() => alsoShownCaptures.map(p => ({ ...p, brief: buildSundayBrief(p.capture, rules, now) })), [alsoShownCaptures, rules, now]);
  // Each one's own rooms and group meetings, from its own check (services-merge.ts otherOperations): never the church's
  // follow-ups (shown with the first service), and a day's rooms with the first service watched on that day.
  const alsoOps = useMemo(() => otherOperations(capture, alsoParts.map(p => p.capture), rules, fictional ? {} : { now }), [capture, alsoParts, rules, now, fictional]);
  // Another service on the first service's day shows that day's rooms when only its check read them in full
  // (services-merge.ts roomsHolders); null with one service, and whenever the first service's check shows them.
  const mainRoomsWith = useMemo(() => firstRoomsWith(capture, alsoParts.map(p => p.capture), rules, fictional ? undefined : now), [capture, alsoParts, rules, now, fictional]);
  // Rooms, follow-ups and group meetings from the capture's own reads, on the church's own time zone
  // (the example's fictional church is on Eastern time). A fictional example is evaluated as of its own check.
  const operations = useMemo(() => capture ? sundayOperations(capture, rules, { ...(fictional ? {} : { now }), ...(mainRoomsWith !== null ? { rooms: false } : {}) }) : null,
    [capture, rules, now, fictional, mainRoomsWith]);
  // Each other service's "Looks good — I'll send it" marks settle after its own live check, as the first service's do above
  // (asked.ts settle drops only that plan's marks that no longer hold).
  const liveAlso = alsoParts.filter(p => p.brief.mode === "live");
  const liveAlsoChecks = liveAlso.map(p => `${p.brief.plan.id}@${p.brief.completed_at}`).join(" ");
  useEffect(() => { for (const p of liveAlso) setAskedMarks(askedStore.settle(p.brief)); }, [liveAlsoChecks, askedStore]);
  // The roles and teams of the check on screen, by their ids, for Church rules, Church lists and the kids question: for a
  // church on another system, its own check's roles (their names local only, as Planning Center's are). With several
  // services watched, every service's teams too (each service type has teams of its own), so a kids team of any watched
  // service can be marked, and adding someone to it gets the kids-team advice (security review of write-back-050, M1).
  const positions = useMemo(() => {
    if (onSystem) return sys.capture ? systemPositions(sys.capture) : [];
    const all = [capture, ...alsoShownCaptures.map(p => p.capture)].filter((c): c is SundayCapture => Boolean(c))
      .flatMap(c => captureToCoverage(c, rules, now).positions);
    return [...new Map(all.map(p => [`${p.team_id}:${p.position_id}`, p])).values()];
  }, [capture, alsoShownCaptures, rules, now, onSystem, sys.capture]);
  const alsoKeys = alsoParts.map(p => decisionsStorageKey(p.brief.mode, p.capture.organization, p.capture.plan_id));
  const [alsoDecisions, setAlsoDecisions] = useDecisionsMap(alsoKeys);
  const others: OtherPart[] = useMemo(() => alsoParts.map((p, i) => ({ plan_id: p.capture.plan_id, brief: p.brief,
    decisions: alsoDecisions[decisionsStorageKey(p.brief.mode, p.capture.organization, p.capture.plan_id)] ?? [], operations: alsoOps[i]?.operations ?? null })),
  [alsoParts, alsoDecisions, alsoOps]);
  // Every service watched, as one check for what counts across them (services-merge.ts): the first service's own brief and
  // decisions when it is the only one.
  const merged = useMemo(() => brief && !offPc ? mergeParts({ brief, decisions }, others) : null, [brief, decisions, offPc, others]);
  // Ask's suggestions with several services speak of them all ("What still needs a decision for your services?"), as its
  // answers do; one service keeps its own day.
  const askBrief = useMemo(() => brief && !offPc && others.length ? { ...brief, day: MANY_SERVICES } : brief, [brief, offPc, others.length]);
  // The decisions across services, kept the same object while none changes (the copies for other apps compare it).
  const mergedDecisions = useMemo(() => mergeDecisions(decisions, alsoShownCaptures.map(p => ({ plan_id: p.capture.plan_id,
    decisions: alsoDecisions[decisionsStorageKey("live", p.capture.organization, p.capture.plan_id)] ?? [] }))), [decisions, alsoShownCaptures, alsoDecisions]);
  // One count everywhere: what the Services page shows (Services findings after decisions, plus rooms, follow-ups and group
  // meetings), across every service watched, each service's own rooms and group meetings once, for the sidebar badge,
  // Today, Ask and the page's own headline.
  const mainOpen = brief ? sundayShownCount(applyDecisions(brief, decisions), operations) : null;
  const open = merged ? withOthers(sundayShownCount(applyDecisions(merged.brief, merged.decisions), operations), others) : mainOpen;
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
    // Genesis: no service, so no day of one; never Planning Center's watched plan from before a switch.
    if (onGenesis) return UNKNOWN_WORDS;
    // A church on another system: the day its own check names, else the day its list gave the watched service.
    if (onSystem) {
      if (sys.built?.brief.day) return sys.built.brief.day;
      const kept = sys.connection?.service_day;
      // B1 Church can save a plan's day a day early far ahead of UTC: its day is named only once the zone is confirmed.
      const trusted = kept && !(onSystem === "b1" && !sys.connection?.zone) && !sys.built?.coverage.waiting_for_zone;
      return trusted ? dayWords({ sort_date: `${kept}T00:00:00`, times: [] }, null) : UNKNOWN_WORDS;
    }
    if (ofWatched?.day) return ofWatched.day;
    const kept = configured ? watchedDay.get(settings.planId) : null;
    return kept ? dayWords(kept, kept.zone) : UNKNOWN_WORDS;
  }, [fictional, brief?.day, ofWatched?.day, configured, settings.planId, watchVersion, onSystem, onGenesis, sys.built?.brief.day, sys.connection?.service_day]);
  noticeDayRef.current = fictional ? undefined : noticeDayOf(day);
  // Moving on by itself (spec §5.3): once the watched plan's day has passed in the church's zone, Ozzie asks for that
  // service's next plan and watches it; with none planned yet, Today says so and it asks again each hour. A failed ask
  // keeps the plan it has and tries again a minute later.
  const [waitingLine, setWaitingLine] = useState<string | null>(null);
  // "Moved on to …" stays on Today for a day, across a relaunch (only the sentence and when; no names). What happened
  // can't hold it yet: its ledger takes only asks, jobs and checks (native ledger_admit), so this is said here (review L12).
  // A church on another system whose service has passed with no next one of it listed yet (Today says so).
  const [systemWaiting, setSystemWaiting] = useState<string | null>(null);
  const forgetMovedLine = () => { setMovedLine(null); try { localStorage.removeItem(MOVED_ON); } catch { /* per-device convenience only */ } };
  const [movedLine, setMovedLine] = useState<{ line: string; at: number } | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(MOVED_ON) ?? "null") as { line?: unknown; at?: unknown } | null;
      return v && typeof v.line === "string" && v.line.length <= 200 && typeof v.at === "number" && Date.now() - v.at < 86_400_000 ? { line: v.line, at: v.at } : null;
    } catch { return null; }
  });
  const moveAsked = useRef(0);
  useEffect(() => {
    // Planning Center's own service only: never on B1 Church, Breeze or Genesis (review of the Genesis merge, L1).
    if (!connected || !configured || fictional || offPc) return;
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
  }, [connected, configured, fictional, offPc, settings.planId, ofWatched?.plan.id, now.slice(0, 16)]);
  // Each other service watched moves on by itself too (spec §5.3): once its plan's day has passed in the church's zone, Ozzie
  // asks for that service's next plan and watches it, saying so on Today; with none planned yet, its part of the Services
  // page says so and it asks again each hour. A failed ask keeps the plan it has and tries again a minute later.
  const alsoAsked = useRef(new Map<string, number>());
  useEffect(() => {
    if (!connected || fictional || offPc) return;
    for (const s of also) {
      const zone = s.zone ?? brief?.time_zone ?? macZone();
      const watched: WatchedPlan = { serviceTypeId: s.serviceTypeId, planId: s.planId, sort_date: s.sort_date, times: s.times, serviceName: s.name };
      if (!hasPassed(watched, zone, now)) continue;
      if (Date.now() - (alsoAsked.current.get(s.serviceTypeId) ?? 0) < (alsoWaiting[s.serviceTypeId] ? WAIT_AGAIN_MS : 60_000)) continue;
      alsoAsked.current.set(s.serviceTypeId, Date.now());
      void moveOn(watched, zone, now, onboarding.nextPlan).then(r => {
        if (r.kind === "moved") {
          setAlso(list => movedOn(list, s.serviceTypeId, s.planId, { id: r.plan.id, sort_date: r.plan.sort_date, times: r.plan.times }, zone));
          setAlsoWaiting(w => Object.fromEntries(Object.entries(w).filter(([k]) => k !== s.serviceTypeId)));
          const moved = { line: r.line, at: Date.now() };
          try { localStorage.setItem(MOVED_ON, JSON.stringify(moved)); } catch { /* per-device convenience only */ }
          setMovedLine(moved);
          // Read the new plan with the others as soon as the list holds it.
          setTimeout(() => { void proactive.checkNow("automatic").then(c => { if (belongs(c)) { setCapture(c); setNow(new Date().toISOString()); } }).catch(() => undefined); }, 1000);
        } else if (r.kind === "waiting") setAlsoWaiting(w => ({ ...w, [s.serviceTypeId]: r.line }));
      }, () => undefined);
    }
  }, [connected, fictional, offPc, also, now.slice(0, 16)]);
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
  // With other services watched (signing in again), it says what they hold too, in the one count (open).
  const firstOthers = !offPc && !fictional ? also.map(s => {
    const o = others.find(x => x.plan_id === s.planId);
    return { name: s.name, when: (o?.brief.day ?? dayWords({ sort_date: s.sort_date, times: s.times }, s.zone)).date,
      decisions: o ? sundayShownCount(applyDecisions(o.brief, o.decisions), o.operations ?? null).decisions : null };
  }) : [];
  const firstResult: ResultView | null = ofWatched && capture && mainOpen ? {
    brief: ofWatched, capture, counts: { decisions: mainOpen.decisions, looks: mainOpen.looks },
    lines: decisionLines(applyDecisions(ofWatched, decisions).items, { rooms: 0, followUps: 0 }, ofWatched.time_zone ?? macZone()).named,
    ...(firstOthers.length ? { others: firstOthers, total: open?.decisions ?? mainOpen.decisions } : {}),
  } : null;
  // The same for a church on another system: its check's counts and lines, with the facts beside them.
  const systemResult: SystemResultView | null = sys.built && sys.capture && mainOpen ? {
    brief: sys.built.brief, capture: sys.capture, counts: { decisions: mainOpen.decisions, looks: mainOpen.looks },
    lines: decisionLines(applyDecisions(sys.built.brief, decisions).items, { rooms: 0, followUps: 0 }, sys.built.brief.time_zone ?? macZone(), day).named,
    notices: sys.built.notices, waitingForZone: sys.built.coverage.waiting_for_zone,
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
  // "Finish setting up" (spec §4.1), from facts only. A church on another system gets only starting with this Mac and AI
  // (below): its service, kids teams and Planning Center's extras are Planning Center's items.
  const pcFinishFacts = {
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
  // A church on another system: no service to choose here (first run chose it) and none of Planning Center's extras; it
  // waits for its system's next service as Planning Center's waits for the next plan.
  const finishFacts = offPc ? { ...pcFinishFacts, service: { deferred: false, watching: true }, kids: { looking: false, answered: false },
    plan: { waiting: Boolean(onSystem && systemWaiting), found: false, service: onSystem ? sys.connection?.service_name ?? null : null }, more: { offered: false, done: false } } : pcFinishFacts;

  // What Check my setup knows from the page (native's setup_check adds its own when it is built). The report never holds
  // the church, plan titles or people: their words are passed as `never`.
  const lastRun = automatic.schedule.last_run;
  const setupKnown = {
    // A church on another system moves on to its next service by itself too, and waits as Planning Center's does.
    connection: status, watched: (onSystem ? systemConfigured : configured) ? { service: onSystem ? sys.connection?.service_name ?? null : null, follows: true, date: day.date } : null,
    ...(onSystem ? { waiting: Boolean(systemWaiting) } : {}), ai: modelStatus,
    system: onSystem ? { name: words.name, church: sys.connection?.church_name ?? null, connected: systemConnected, id: onSystem }
      // Genesis: its own row, and no service to choose (review of e9cbd97d, M5).
      : onGenesis ? { name: words.name, church: sys.state.genesis?.church_name ?? null, connected: Boolean(sys.state.genesis), id: "genesis" as const } : null,
    aiCompany: modelStatus?.provider ?? null,
    lastCheck: lastRun ? { outcome: lastRun.outcome, at_ms: Date.parse(lastRun.finished_at) } : null,
    never: [...Object.values(capture?.names ?? {}), ...Object.values(sys.capture?.names ?? {}), ...(sys.connection?.church_name ? [sys.connection.church_name] : []),
      ...(sys.state.genesis?.church_name ? [sys.state.genesis.church_name] : []),
      ...(status?.organization_name ? [status.organization_name] : []), ...(brief?.plan.title ? [brief.plan.title] : []),
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
    // Every service watched, as the page shows them: the round that just finished read the others too.
    return mergedHarness(c, at, latestState.current, refresh);
  }, []);
  // Once the leader's own calendar is on Today, Ask no longer uses the fictional email import Today stopped showing.
  const fictionalImport = !calendarsConnected(calendarState);
  // Ask, and the copies for Siri and other AI apps, read every service watched (services-merge.ts): the same count as the
  // page, with the names of everyone the other services' checks named, so a name in a question is replaced before sending.
  // The same object until a check changes it (not every second), so a copy for other apps is written once per check.
  const harnessCapture = useMemo(() => capture && alsoShownCaptures.length ? mergedNames(capture, alsoShownCaptures.map(p => p.capture)) : capture, [capture, alsoShownCaptures]);
  const harnessBrief = merged?.brief ?? brief, harnessDecisions = offPc ? decisions : mergedDecisions;
  // Answers written on this Mac name each role's service when more than one is watched ("Greeter (Youth Night)").
  const serviceOfTeam = useMemo(() => brief && !offPc ? teamServices({ brief, name: watchedDay.get(settings.planId)?.service ?? null },
    alsoParts.map(p => ({ brief: p.brief, name: p.service.name }))) : undefined, [brief, offPc, alsoParts, settings.planId]);
  // The same for Church lists' matching, which keeps to its own modules (church-notes.tsx).
  const listsTeamServices = useMemo(() => serviceOfTeam ? new Map(Object.entries(serviceOfTeam)) : undefined, [serviceOfTeam]);
  // Ask: a question may name any service watched, never beside the example; its name becomes a label and is never sent,
  // and the answer is about that service only (core ask.ts PrepareOptions `services`, harness tools.ts `scope`).
  const askedServices = useMemo(() => brief && !offPc ? askServices({ brief, name: watchedDay.get(settings.planId)?.service ?? null },
    alsoParts.map(p => ({ plan_id: p.capture.plan_id, brief: p.brief, name: p.service.name })),
    fictional ? [] : also.filter(s => !alsoParts.some(p => p.service.serviceTypeId === s.serviceTypeId)).map(s => s.name)) : undefined,
  [brief, offPc, alsoParts, also, fictional, settings.planId]);
  // Today's Thursday brief and spoken briefing say which service a part of the check that couldn't be checked is at, as Ask
  // does, by a name a person would recognise (services-merge.ts findingServices); undefined with one service. Never sent.
  const findingServiceNames = useMemo(() => brief && !offPc ? findingServices({ brief, name: watchedDay.get(settings.planId)?.service ?? null },
    alsoParts.map(p => ({ plan_id: p.capture.plan_id, brief: p.brief, name: p.service.name })),
    fictional ? [] : also.filter(s => !alsoParts.some(p => p.service.serviceTypeId === s.serviceTypeId)).map(s => s.name)) : undefined,
  [brief, offPc, alsoParts, also, fictional, settings.planId]);
  // Today, Thursday's brief and the spoken briefing say each service's rooms and group meetings with its own service, by a
  // name a person would recognise (services-merge.ts alsoOperations); undefined with one service. Never sent.
  const alsoOpsWords = useMemo(() => brief && !offPc ? alsoOperations({ brief, name: watchedDay.get(settings.planId)?.service ?? null },
    alsoParts.map(p => ({ plan_id: p.capture.plan_id, brief: p.brief, name: p.service.name })), alsoOps,
    fictional ? [] : also.filter(s => !alsoParts.some(p => p.service.serviceTypeId === s.serviceTypeId)).map(s => s.name)) : undefined,
  [brief, offPc, alsoParts, alsoOps, also, fictional, settings.planId]);
  // Native's own check refuses any request that still holds one of those names (name_guard.rs `service_named`): told
  // when the page starts (so a page loaded again never leaves native an older list) and whenever they change, held in
  // memory only; with one service it holds none. Kept as told only once native took it, and tried again up to three
  // times for each list when it didn't (review A, L6).
  const watchedNames = JSON.stringify(askedServices?.services.map(s => s.name) ?? []);
  const toldNative = useRef<string | null>(null);
  const nativeTries = useRef({ names: "", count: 0 });
  const [nativeRetry, setNativeRetry] = useState(0);
  useEffect(() => {
    if (watchedNames === toldNative.current) return;
    if (nativeTries.current.names !== watchedNames) nativeTries.current = { names: watchedNames, count: 0 };
    try {
      void invoke("remember_watched_services", { names: JSON.parse(watchedNames) as string[] })
        .then(() => { toldNative.current = watchedNames; }, () => {
          if (nativeTries.current.names === watchedNames && ++nativeTries.current.count <= 3) setTimeout(() => setNativeRetry(n => n + 1), 5_000);
        });
    } catch { /* not in the app */ }
  }, [watchedNames, nativeRetry]);
  // Ask's suggested questions say which service's role they mean when two services hold one of that name.
  const chipServices = useMemo(() => serviceOfTeam && merged ? { teams: serviceOfTeam, positions: rolePositions(merged.brief) } : undefined, [serviceOfTeam, merged]);
  // Each other service's own rooms and group meetings, by its name, for a question about it and for the copies.
  const harnessAlsoOps = useMemo(() => offPc ? undefined : harnessOperations(alsoParts.map((p, i) => ({ name: p.service.name, operations: alsoOps[i]?.operations ?? null,
    roomsWith: alsoOps[i]?.roomsWith ?? null }))), [offPc, alsoParts, alsoOps]);
  const pcHarnessData = useMemo(() => buildHarnessData({
    capture: harnessCapture, fictional, rules, decisions: harnessDecisions, status, configured: Boolean(org && configured), now, brief: offPc ? null : harnessBrief, operations, fictionalImport,
    serviceOfTeam, ...askedServices, alsoOperations: harnessAlsoOps,
  }, refreshForHarness), [harnessCapture, fictional, rules, harnessDecisions, status, org, configured, now, harnessBrief, operations, fictionalImport, refreshForHarness, offPc, serviceOfTeam, askedServices,
    harnessAlsoOps]);
  // A church on B1 Church or Breeze: Ask reads its own check (or its fictional example) through the same tools, with the
  // system named as the source; its names stay on this Mac as Planning Center's do (harness-bridge systemHarnessCapture).
  // It offers no Planning Center check again, and nothing of Calendar, People or Groups.
  const systemShownCapture = onSystem ? (fictional ? systemExample?.capture ?? null : sys.capture) : null;
  const harnessData = useMemo(() => onSystem ? buildHarnessData({
    capture: systemShownCapture ? systemHarnessCapture(systemShownCapture, !fictional && sys.saved) : null, fictional, rules, decisions, status: null, configured: false, now,
    brief, operations: null, fictionalImport: false, source: words.name,
  }) : pcHarnessData, [onSystem, systemShownCapture, fictional, sys.saved, rules, decisions, now, brief, words.name, pcHarnessData]);
  const dataNow = useRef(harnessData);
  dataNow.current = harnessData;
  const workspace = org || "this-mac";
  // A new harness for each system the church uses: its tools are bound to that system's checks (their service type).
  const harness = useMemo(() => procedures
    ? createAppHarness({ workspace_id: workspace, data: dataNow.current, skills: procedures, session: harnessSession, loop, recorder }) : null,
  [procedures, workspace, loop, harnessSession, recorder, onSystem]);
  useEffect(() => { harness?.update(harnessData); }, [harness, harnessData]);
  // "Use Ozzie's last check in other AI apps" (Settings): off unless the leader turns it on; only this church's check.
  // Planning Center's check only: sharing a church system's check with other apps isn't built yet (pcHarnessData has none).
  const sharing = useSharing(pcHarnessData, harnessSession, ledgerVersion, { organization: org, status });
  // "Let Siri and Shortcuts ask Ozzie" (Settings): off unless the leader turns it on; the same rule for which check.
  const shortcuts = useShortcuts(pcHarnessData, harnessSession, { organization: org, status });
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
  // The same look on a second or later service's card (owner decision 2026-11-19): over that service's own check, brief and
  // decisions alone (harness-bridge otherServiceData), so it is about that service's role, never another service's of the
  // same name, and no service's name is in anything sent. The first service's look above is unchanged.
  const whoCouldHelpIn = (part: { capture: SundayCapture; brief: SundayBrief }, decided: readonly SundayDecision[]): WhoCouldHelp | undefined => procedures && modelReady
    ? (finding, signal) => lookAtWhoCouldHelp(d => createAppHarness({ workspace_id: workspace, data: d, skills: procedures, session: harnessSession, loop, recorder }),
      otherServiceData({ capture: part.capture, brief: part.brief, decisions: decided }, { rules, status, configured: Boolean(org && configured), now }), finding,
      { signal, recorder, skills: procedures, sender: yourName.get() })
      .finally(() => { void recorder.idle().then(() => setLedgerVersion(v => v + 1)); })
    : undefined;

  // Says whether the check came (a change's role waits for it).
  const act = async (work: () => Promise<SundayCapture>, isFictional = false): Promise<boolean> => {
    setBusy(true); setProblem(""); setRefused(false);
    try { setCapture(await work()); setFictional(isFictional); setNow(new Date().toISOString()); return true; }
    catch (error) { setProblem(sundayProblem(error)); setRefused(refusedRead(error)); return false; }
    finally { setBusy(false); }
  };
  // Same check as always (re-verify a saved connection, then read), through the one path that
  // never runs two checks at once and remembers what changed.
  const check = () => act(() => proactive.checkNow());
  // ---- Changes in Planning Center the leader confirms one at a time (change-card.tsx; owner decisions 2026-11-17 and
  // 2026-11-21) ----
  // Planning Center only: a church on B1 Church, Breeze or Genesis gets no switch, no button and no change line, and
  // native code refuses there too (changes.rs). Off unless turned on for the church in use.
  // Each Disconnect tried from Settings or first run, however it ended: the switch is read again after it.
  const [disconnectTries, setDisconnectTries] = useState(0);
  const kidsTeamIds = useMemo(() => kidsTeams(rules).map(t => t.team_id), [rules]);
  // The live check on screen of each service watched, by its plan: a role waiting after a change shows its people again
  // once its own plan's new check is in (another service's check doesn't end the wait).
  const checkedPlans = useMemo<Readonly<Record<string, string>>>(() => offPc || fictional ? {} : Object.fromEntries([
    ...(capture && capture.kind === "live" && capture.organization === org ? [[capture.plan_id, capture.completed_at] as const] : []),
    ...alsoShownCaptures.filter(p => p.capture.kind === "live").map(p => [p.capture.plan_id, p.capture.completed_at] as const),
  ]), [offPc, fictional, capture, org, alsoShownCaptures]);
  // After anything is sent, native code drops the check of that plan, so a fresh round is taken: it says whether that plan's
  // own new check came (the first service's, or another's, which reaches App during the round: onAlsoCapture).
  const afterWrite = async (plan: string): Promise<boolean> => {
    if (!alsoNow.current.also.some(x => x.planId === plan)) return check();
    const before = alsoNow.current.captures[plan]?.completed_at;
    const ok = await check();
    const after = alsoNow.current.captures[plan]?.completed_at;
    return ok && Boolean(after) && after !== before;
  };
  const changes = useChanges({ organization: offPc ? "" : org, connected: connected && !offPc, disconnected: status?.state === "disconnected", kidsTeamIds,
    afterWrite, checked: checkedPlans, showingHistory: page === "activity", disconnectTries });
  const changesOn = !offPc && changes.on;
  // Every "reads only / changes only when you confirm" line follows one rule: the on form only while Planning Center is
  // connected and the switch is on; otherwise the off form, whose words hold with the switch on but not connected.
  const changesShownOn = connected && changesOn;
  // Without People access native code refuses every change (it can't see whether someone is listed as a child): none is offered.
  const peopleOk = operationsGranted(status);
  // First run opens by itself only at launch, at the first unmet fact (spec §0.3): not connected, nothing watched, or no
  // result seen yet (no saved check of this church). Once launch, the status and the saved checks are known, it is
  // decided once; then it stays as the person leaves it, and opens again only from a button.
  const recordingsKnown = !org || recordingsFor === org;
  // The launch's check of this Mac's saved sign-in is under way for a church set up here: nothing says "not connected"
  // or offers Connect until it answers; the last saved check is shown meanwhile (0.3.0 live click-through).
  // Not while still choosing after "Use a different system" (review of the polish, L2): no system is in use yet.
  const checkingSaved = !offPc && !sys.state.choosing && (!launchChecked || rechecking) && Boolean(org) && !fictional;
  // The launch check had no answer and nothing is known since: said, with "Check the connection" (review L6).
  const checkStuck = !offPc && launchStuck && !checkingSaved && Boolean(org) && !fictional && status === null;
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
  // A brand-new Mac (no church saved) shows the first screen at once: no page is drawn while that is being decided. So
  // does a Mac still choosing after "Use a different system" (polish 2026-11-21).
  const deciding = setup === "auto" && (!org || sys.state.choosing === true) && !fictional;
  // A result counts as seen once a check of the watched plan is on screen, even before its saved copy is listed.
  const facts = { status, watching: Boolean(org && configured), resultSeen: recordings.length > 0 || Boolean(ofWatched), memory: setupMemo.get() };
  // A church on another system opens at its own first unmet fact: connect, then the service and a first result.
  const systemAt = onSystem ? systemFirstRunAt(sys.state, Boolean(sys.connection?.result_seen) || Boolean(sys.built)) : null;
  const systemSetup: FirstRunScreen | null = systemAt === "connect" ? "first" : systemAt === "service" ? "service" : null;
  // Genesis: first run until its key, the church's zone and a first result are all in.
  const genesisSetup: FirstRunScreen | null = sys.state.genesis?.zone && sys.state.genesis.result_seen ? null : "first";
  // A Mac that pressed "Use a different system" and quit before choosing opens at the choice again (polish 2026-11-21).
  const setupFor = (): FirstRunScreen | null => onSystem ? systemSetup : onGenesis ? genesisSetup
    : sys.state.main === null && sys.state.choosing && !isConnected(status) ? "first" : firstRunScreen(facts);
  useEffect(() => {
    if (setup === "auto" && launched && launchChecked && statusRead && recordingsKnown) setSetup(setupFor());
  }, [setup, launched, launchChecked, statusRead, recordingsKnown]);
  // A Mac already set up with Planning Center keeps it as its system: "What does your church use?" is only for a new Mac.
  // Once, at launch: a choice made later ("Use a different system") is never undone by it (review L4).
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current) return;
    if (sys.state.main !== null) { migrated.current = true; return; }
    // Chose "Use a different system" and quit before choosing: still choosing, unless Planning Center is connected now.
    if (sys.state.choosing && !isConnected(status)) return;
    if (Boolean(org) || isConnected(status)) { migrated.current = true; sys.setState({ ...sys.state, main: "planning-center" }); }
  }, [sys.state.main, sys.state.choosing, org, status?.state]);
  // Every read of a church on another system (on its own, Check now, first run, a zone or service just chosen) reads the
  // service the connection kept on this Mac names when it starts. Once that service's day has passed, Ozzie moves on to
  // the system's next one of the same service first, as it does for Planning Center (spec §5.3), and says so on Today;
  // with none listed yet it reads the one it has and says it is waiting.
  systemRead.current = async (): Promise<SystemCapture> => {
    const held = churchSystem.get();
    const c = isOtherSystem(held.main) ? held.connection : null;
    if (!c?.service_id) throw new SystemReadFailure(c?.system ?? "b1", "bad-id", c?.church_id ?? null);
    const today = macToday();
    if (c.service_day && c.service_day < today) {
      const r = await churchSystems.choices(c.system, c.church_id);
      // The next one of the same service (by the name the system gives it, as Planning Center keeps the service type),
      // never another kind of plan or event (final review M2). With none listed yet, Ozzie waits and says so.
      const same = r.choices.filter(x => !c.service_name || x.name === c.service_name);
      // B1 Church lists a plan a day early far ahead of UTC: the list is compared as listedToday says (system-setup.ts).
      const first = r.outcome === "ok" ? soonest(same, listedToday(c.system)) : null;
      if (r.outcome === "ok" && !first) {
        setSystemWaiting(`No upcoming ${c.service_name ? `${c.service_name} ` : ""}${c.system === "b1" ? "plan" : "event"} is listed in ${systemWords(c.system).name} yet. Ozzie looks again each time it checks.`);
      } else setSystemWaiting(null);
      // Moved on only while the same church and service are still watched (a switch may have come meanwhile).
      const still = churchSystem.get().connection;
      // Built from what is kept now, so a zone or name confirmed while the list was read stays (review L1).
      if (first && first.id !== c.service_id && still && still.church_id === c.church_id && still.system === c.system && still.service_id === c.service_id) {
        sysNow.current.setState({ ...churchSystem.get(), connection: { ...still, service_id: first.id, service_day: first.day, service_name: first.name } });
        const moved = { line: `Moved on to ${choiceLine(first)} because ${longDate(c.service_day)} has passed.`, at: Date.now() };
        try { localStorage.setItem(MOVED_ON, JSON.stringify(moved)); } catch { /* per-device convenience only */ }
        setMovedLine(moved);
      }
    } else setSystemWaiting(null);
    // The service the connection names now: moved on, or chosen by the person while the list was read.
    const kept = churchSystem.get();
    const next = isOtherSystem(kept.main) ? kept.connection : null;
    if (!next?.service_id || next.system !== c.system || next.church_id !== c.church_id) throw new SystemReadFailure(c.system, "busy", c.church_id);
    const r = await readSystem(next);
    if (!r.capture) throw new SystemReadFailure(next.system, r.outcome, next.church_id);
    return r.capture;
  };
  const showSetup = setup !== "auto" && setup !== null;
  // Setup is unfinished while a required fact is unmet (once launch has decided): the sidebar's first entry leads back.
  const setupAt = setup === "auto" || fictional || addingAccess || reconnecting ? null : setupFor();
  // The sidebar's entry and the screen agree: it shows while setup is on screen (step 3's result included), and while a
  // required fact is unmet (0.3.0 live click-through).
  const setupEntry = showSetup || setupAt !== null;
  // A first result has been seen (a saved check of this church, or one on screen): AI and Ask come into view.
  const resultSeen = onSystem ? Boolean(sys.connection?.result_seen) || Boolean(sys.built)
    : onGenesis ? Boolean(sys.state.genesis?.result_seen) || Boolean(genesis.capture) : recordings.length > 0 || Boolean(ofWatched);
  // AI and Ask wait only while setup is on screen without a result: once a person leaves setup (Not now, the sidebar, the
  // example), they can reach both even if no result ever comes (re-check Low).
  const askShown = resultSeen || setup === null;
  /** Opens first run where it fits now: the browser step from Today, the first unmet fact elsewhere (the service once connected). */
  const openSetup = (at?: FirstRunScreen) => { setSetupKey(k => k + 1); setSetup(at ?? setupFor() ?? (onGenesis ? "first" : "service")); };
  // The saved checks of the church on another system, deleted from this Mac (Settings' Delete saved checks, a disconnect).
  const forgetSystemChecks = (): Promise<boolean> => {
    const c = churchSystem.get().connection;
    return c ? deleteChecksOrLater(c) : Promise.resolve(true);
  };
  // Switching the church's main system (Settings, one at a time): what it forgets is said there before this runs.
  const switchSystem = async (to: MainSystem): Promise<string | null> => {
    const from = sys.state;
    const c = from.connection;
    // The old system is let go first; if that fails, nothing switches and Settings says so (review M1).
    if (c) {
      const word = await churchSystems.forget(c.system, c.church_id);
      if (word !== "forgotten") return `This Mac didn't let Ozzie remove the ${systemWords(c.system).name} key just now, so nothing was switched. Unlock this Mac (type your Mac password if it asks), then try again.`;
      // Its saved checks hold volunteers' names: they go with it, or are kept to delete again (church-system.ts).
      void deleteChecksOrLater(c);
    } else if (from.main === "planning-center" && (Boolean(org) || (status !== null && status.state !== "disconnected"))) {
      // Leaving Planning Center for another system: native code turns adding people off for the church left, however
      // the Disconnect ends, so the switch is read again.
      const after = await connection.disconnect().catch(() => null).finally(() => setDisconnectTries(n => n + 1));
      if (after) setStatus(after);
      if (after?.state !== "disconnected") return "Ozzie couldn't sign out of Planning Center just now (a check may be under way), so nothing was switched. Wait a moment, then try again.";
    }
    // Nothing of the church's last check is shared on after a switch: other AI apps, Siri and Shortcuts, and jobs' write-ups.
    sharing.forget(); shortcuts.forget(); runner.forgetAllWriteups();
    // Open visitor cards end, as the question said (final review L1), and so does the last "Moved on to …" line.
    if (openCards > 0) discardCards();
    forgetMovedLine();
    sys.forgetCheck();
    sys.setState({ main: to, connection: null, genesis: from.genesis });
    setSetupKey(k => k + 1); setSetup("first");
    return null;
  };

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
  const showExample = () => {
    // A church on B1 Church or Breeze sees its own system's example church (memo above), never Planning Center's.
    if (onSystem || onGenesis) { setCapture(null); setFictional(true); setProblem(""); setRefused(false); setNow(new Date().toISOString()); return; }
    void act(() => Promise.resolve(withFictionalOperations(nov22Capture())), true);
  };
  // Nothing chosen yet (a fresh Mac): leaving the example goes back to "What does your church use?" (round 5).
  const leaveExample = () => { setCapture(null); setFictional(false); setProblem(""); setRefused(false); if (nothingChosen) { setSetupKey(k => k + 1); setSetup("first"); } };
  // The regular Sunday check as Today shows it (audit item 24): its schedule, last and next look, and what it missed today.
  // What quitting would stop or lose, told to native code as it changes: open cards (a count) and whether the regular
  // Sunday check or any job is on.
  // Someone added this session who can still be taken off is lost on quit too, so it is asked then as well; the question's
  // own line about checks follows whether checks are really on.
  const checksNow = checksOn({ readiness, schedule: automatic.schedule, watch });
  useQuitGuard(openCards, { readiness, schedule: automatic.schedule, watch }, changes.undoable.length > 0);
  // Ask's suggested questions move on from a role the person settled since the check: their own mark on the Services page,
  // or an add made through Ozzie that fills it (ask-panel.tsx settledRoles, change-card.tsx filledByAdds). Display only.
  const chipSettled = useMemo(() => brief ? settledRoles(merged?.brief ?? brief, merged?.decisions ?? decisions,
    // Adds on any watched service's plan, each other service's under its own keys (mergeParts): review of 0.5.10.
    [...filledByAdds(brief, changes.results), ...(merged ? others.flatMap(o => filledByAdds(o.brief, changes.results).map(k => partKey(o.plan_id, k))) : [])]) : undefined,
  [brief, merged, others, decisions, changes.results]);
  // With more than one service watched, the questions are chosen from every watched service's findings, the first service's
  // first: once its roles are settled or covered they move on to the next service's (0.5.9 looked at the first service only).
  const chipFindings = merged && others.length ? merged.brief.findings : undefined;
  // While a Planning Center sign-in is in the browser, checks wait so as not to cancel it, and the church in use is still
  // connected: Today says what was true before it started, never "Nothing runs yet" (review 2026-11-18).
  const shownReadiness = useHeldWhile(readiness, status?.state === "waiting" || status?.state === "checking");
  // A church on another system: its own schedule's state (automatic is already its view).
  const regular: RegularCheck = {
    ready: onSystem ? systemWatchReady : shownReadiness === "ready", paused: automatic.schedule.paused, running: automatic.running || (onSystem ? sys.busy : busy),
    intervalMinutes: automatic.prefs.intervalMinutes, runOnLaunch: automatic.prefs.runOnLaunch,
    last: automatic.schedule.last_run ? { at: automatic.schedule.last_run.finished_at, ok: automatic.schedule.last_run.outcome === "ok" } : null,
    next: automatic.schedule.next_run_at,
    missed: automatic.history.filter(e => e.kind === "missed" && e.scheduled_for && Date.parse(now) - Date.parse(e.at) < 86_400_000).map(e => e.scheduled_for!),
  };
  // Genesis's own reads, said on Today as the regular check is (review of e9cbd97d, H1): on opening and on the interval.
  const genesisRegular: RegularCheck = {
    ready: Boolean(sys.state.genesis?.zone && sys.state.genesis.result_seen), paused: automatic.schedule.paused, running: genesis.busy,
    intervalMinutes: automatic.prefs.intervalMinutes, runOnLaunch: true,
    last: genesis.last, next: null, missed: [],
  };
  // Names for "What changed" come only from the current real check of the same organization.
  // With other services watched, their people too (Keeping watch lists their changes).
  const changeNames = capture && !fictional && capture.organization === org ? harnessCapture?.names ?? capture.names : {};
  // What happened's changes name people from every service's live check on screen (a change on another service's plan
  // names someone that service's check read).
  const historyNames = useMemo(() => Object.assign({}, ...alsoShownCaptures.map(p => p.capture.names), changeNames) as Readonly<Record<string, string>>,
    [alsoShownCaptures, changeNames]);
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
    existing: watch.items, pausedAll: watch.paused_all, church: inUse?.name ?? null, several: !offPc && !fictional && also.length > 0,
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
  // ⌘+ makes everything bigger, as View › Bigger Text (⌘=) does (text-size.ts; accessibility audit B1).
  useBiggerTextKey();
  // Closing Ask puts keyboard focus back on the button that opens it, rather than nowhere: once the sidebar is no longer
  // inert under it (below), so after the close has drawn, and only when nothing on the page took it meanwhile (Ask's
  // "Choose how Ozzie uses AI" opens the AI screens, whose title takes it).
  const askEntry = useRef<HTMLButtonElement>(null);
  const askClosing = useRef(false);
  const closeAsk = () => { askClosing.current = true; setAskOpen(false); };
  useEffect(() => {
    if (askOpen || !askClosing.current) return;
    askClosing.current = false;
    const at = document.activeElement;
    if (!(at && at.tagName !== "BODY" && (side.current?.contains(at) || mainRef.current?.contains(at)))) askEntry.current?.focus();
  }, [askOpen]);
  // Narrower than ASK_DOCKS_AT, Ask lies over the page (over the whole window under 760px): while it's open the sidebar and
  // the page under it are inert, so Tab, Full Keyboard Access and VoiceOver can't reach controls it hides (accessibility
  // audit S1, WCAG 2.4.11). Escape or its close button closes it. Docked, the page beside it stays in use.
  const askDocked = useAskDocked();
  const askCovers = askOpen && !askDocked;
  // Escape closes it wherever the keyboard is (a click on the dimmed page leaves it on nothing).
  useEffect(() => {
    if (!askCovers) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) closeAsk(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [askCovers]);
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
  // A church on another system: its own connection decides, never Planning Center's status.
  // Genesis: no service, so nothing to decide is counted there.
  const sundayBadge = onGenesis || (!fictional && (onSystem ? !systemConnected : status?.state === "disconnected")) ? 0 : sundayCount(open);
  // Jobs read Planning Center checks only: on another system none runs, so none counts here.
  const automaticCount = page !== "automatic" ? automatic.unseen + (offPc ? 0 : watch.unseen) : 0;
  // The sidebar keeps its words at every width (audit item 22c); a narrow window puts them under Menu, which Escape closes.
  // Its two lines (what Ozzie reads or changes; the church in use) go under Menu too, and the church stays in the bar (review F, L-6).
  // The church's name stays in the sidebar while a sign-in for it is in the browser (native names no church in use then).
  const shownChurch = inUse ?? (reconnecting || addingAccess ? heldInUse : null);
  const churchLine = onSystem ? (!sys.connection ? words.notConnected : sys.connection.church_name ? words.connectedTo(sys.connection.church_name) : words.connected)
    : onGenesis ? (!sys.state.genesis ? words.notConnected : sys.state.genesis.church_name ? words.connectedTo(sys.state.genesis.church_name) : words.connected)
    : nothingChosen && !checkingSaved ? NOT_CHOSEN.notConnected
    : checkingSaved && !connected ? CHECKING_LINE : checkStuck ? STUCK_LINE : !stillConnected ? "Planning Center not connected" : shownChurch?.name ? `Planning Center: ${shownChurch.name}` : "Planning Center connected";
  // Check now moves on first too, when the watched service has passed.
  const systemCheck = () => { void sys.check(); };
  // A system check reads the key Ozzie keeps first: while macOS asks the person about it, the service's page says so.
  const systemAsking = useKeychainAsking(Boolean(onSystem) && (sys.busy || systemAutomatic.running));
  // The person's own schedule and quiet hours hold for whichever system the church uses.
  const setPrefs = (p: ProactivePrefs) => { proactive.setPrefs(p); systemProactive.setPrefs(p); };
  const systemReadiness: Readiness = systemWatchReady ? "ready" : sys.connection ? "not-configured" : "not-connected";
  // Why its checks don't run yet, in its own words (review L7): the zone to confirm, or first run to finish.
  const systemNotReady = !onSystem || systemWatchReady || !sys.connection?.service_id ? null
    : onSystem === "b1" && !sys.connection.zone ? "Confirm your church's time zone under Settings, then checks start on their own."
      : `Finish setting up ${words.name}, then checks start on their own.`;
  // "What does your church use?" comes first on a Mac with no church yet (decision 21).
  const choosing = sys.state.main === null && !isConnected(status) && setup === "first";

  // ---- More than one service (owner decision 2026-11-19) ----
  // The first service's own Planning Center name, as first run and the last check kept it.
  const mainName = watchedDay.get(settings.planId)?.service ?? null;
  // Planning Center only (never B1 Church, Breeze or Genesis), a church's own services, more than one: the Services page holds each as a part, in date order.
  const servicesShown = !offPc && !fictional && also.length > 0;
  // Read the list with the others at once, as Check now does (one round, one at a time).
  // A round already under way read the list as it was when it started: then one more round follows it.
  const checkAll = () => {
    const show = (c: SundayCapture) => { if (belongs(c)) { setCapture(c); setNow(new Date().toISOString()); } };
    setTimeout(() => {
      const after = proactive.view().running;
      void proactive.checkNow("automatic").then(c => { show(c); if (after) void proactive.checkNow("automatic").then(show).catch(() => undefined); }).catch(() => undefined);
    }, 1000);
  };
  // "Watch another service" (watch-another.tsx): kept for this church, then read with the others.
  const addAlso = (choice: ServiceChoice) => { setAlso(list => addService(list, choice, settings.serviceTypeId, brief?.time_zone ?? null) ?? list); checkAll(); };
  // "Stop watching": its saved checks on this Mac and the leader's decisions for it are forgotten first, as the question
  // said; if this Mac doesn't let Ozzie remove the saved checks, it stays watched and says so.
  const removeAlso = async (serviceTypeId: string): Promise<string | null> => {
    const gone = also.find(s => s.serviceTypeId === serviceTypeId);
    if (!gone) return null;
    // Never the first service's own plan, whatever the list holds.
    const plans = removeService(also, serviceTypeId).plans.filter(p => p !== settings.planId);
    // It stops being read first, at once (a round under way reads only what is watched; one already reading it hands back
    // the copy native saves, which is deleted again: onAlsoDropped), then its saved checks go.
    const without = (list: AlsoWatched[]) => removeService(list, serviceTypeId).list;
    alsoNow.current.also = without(alsoNow.current.also);
    current.current = { ...current.current, also: current.current.also.filter(p => p.serviceTypeId !== serviceTypeId) };
    setAlso(without);
    if (org && plans.length) {
      try { await sundaySource.deletePlanRecordings(org, plans); }
      catch {
        setAlso(list => list.some(s => s.serviceTypeId === serviceTypeId) ? list : [...list, gone]);
        return "Ozzie couldn't remove that service's saved checks from this Mac just now, so it is still watched. Try again in a moment.";
      }
      for (const plan of plans) try { localStorage.removeItem(decisionsStorageKey("live", org, plan)); } catch { /* per-device convenience only */ }
      // Its "Looks good — I'll send it" marks go with its decisions (asked.ts forget); the other services' stay.
      setAskedMarks(askedStore.forget(plans));
    }
    proactive.forgetPlans(plans);
    alsoNow.current.captures = Object.fromEntries(Object.entries(alsoNow.current.captures).filter(([k]) => !plans.includes(k)));
    setAlsoCaptures(alsoNow.current.captures);
    setAlsoProblems(p => Object.fromEntries(Object.entries(p).filter(([k]) => !plans.includes(k))));
    setAlsoWaiting(w => Object.fromEntries(Object.entries(w).filter(([k]) => k !== serviceTypeId)));
    refreshRecordings();
    return null;
  };
  // Which services Ozzie watches, with Watch another service: on Settings and at the end of the Services page, once a
  // first service is watched (first run chooses that one, as before).
  const pcWatch = !offPc && !fictional && org && configured ? <WatchedServices mainName={mainName} mainTypeId={settings.serviceTypeId} also={also}
    connected={connected} zone={brief?.time_zone ?? null} pick={() => onboarding.pickService()} onAdd={addAlso} onRemove={removeAlso}
    // Kept for the plan Settings watch when the list comes back (it may have moved on meanwhile), only while that is still
    // the same service and its name isn't known (review of polish 3, L3).
    onMainName={(name, typeId) => {
      const s = current.current.settings;
      if (s.serviceTypeId !== typeId || watchedDay.get(s.planId)?.service) return;
      watchedDay.named(s.planId, name); setWatchVersion(v => v + 1);
    }} /> : null;
  const focusFor = (planId: string) => { const f = sundayFocus ? fromPartKey(sundayFocus) : null; return f && f.plan_id === planId ? f.key : null; };
  // Each other service's part: its latest check (or that none is read yet), its own decisions, its own problem or wait,
  // and its own rooms and group meetings (the church's follow-ups are the first service's). Its notes' "Looks good — I'll
  // send it" marks are its own plan's (asked.ts), and its AI look reads its own check alone (whoCouldHelpIn).
  // Each watched service's Planning Center name by its service type, for What happened's lines (review of write-back-050, L6).
  const serviceNamesById: Readonly<Record<string, string>> = Object.fromEntries([[settings.serviceTypeId, mainName], ...also.map(x => [x.serviceTypeId, x.name] as const)]
    .filter((e): e is [string, string] => Boolean(e[1])));
  // A change's slot for one service's part of the Services page (owner decision 2026-11-21: any Planning Center service
  // watched): only for a live check of the church in use, on that service's own plan, with its name and zone for the
  // confirmation. What came back from a change shows on its own plan's part.
  const mainLive = Boolean(liveBrief && capture?.kind === "live" && capture.organization === org && !offPc);
  const alsoLive = (p: (typeof alsoParts)[number] | undefined) => Boolean(p && p.capture.kind === "live" && p.brief.mode === "live");
  const changeSlot = (plan: string, zone: string | null, service: string | null): SundayChanges | null => changesOn
    ? sundayChanges({ control: changes, zone, openPc: openInPlanningCenter, people: peopleOk, plan, service, resultsHere: planOf => planOf === plan }) : null;
  const changesOnSunday = mainLive && liveBrief ? changeSlot(liveBrief.plan.id, liveBrief.time_zone, mainName) : null;
  // Plans whose part shows a live check now. A result on any other plan (the service moved on, stopped being watched, or its
  // part shows a saved check) is shown above the parts, so its "Take … off again" stays reachable while Ozzie is open
  // (review of write-back-050, L5).
  const liveSlotPlans = [...(mainLive && liveBrief ? [liveBrief.plan.id] : []), ...(servicesShown ? alsoParts.filter(alsoLive).map(p => p.capture.plan_id) : [])];
  const resultsElsewhere = changesOn && changes.results.some(r => !liveSlotPlans.includes(r.plan))
    ? <div className="col change-elsewhere"><ChangeResults slot={{ control: changes, zone: brief?.time_zone ?? null, openPc: openInPlanningCenter, people: peopleOk,
      plan: "", service: null, resultsHere: planOf => !liveSlotPlans.includes(planOf) }} /></div> : null;
  // The service whose part shows a day's rooms (services-merge.ts otherOperations `roomsWith`), by its name.
  const roomsHolder = (at: number | null | undefined): string | null => at === null || at === undefined ? null
    : at === 0 ? mainName ?? "your first service" : alsoParts[at - 1]?.service.name ?? SERVICE_UNNAMED;
  const otherParts = servicesShown ? also.map(s => {
    const p = alsoParts.find(x => x.service.serviceTypeId === s.serviceTypeId);
    const ops = p ? alsoOps.find(x => x.plan_id === p.capture.plan_id) : undefined;
    const words = p?.brief.day ?? dayWords({ sort_date: s.sort_date, times: s.times }, s.zone);
    const key = p ? decisionsStorageKey(p.brief.mode, p.capture.organization, p.capture.plan_id) : null;
    const decided = key ? alsoDecisions[key] ?? [] : [];
    return { key: `service:${s.serviceTypeId}`, date: p?.brief.plan.date ?? planDate(s.sort_date), dayText: words.date, node: <DayProvider value={words}>
      <SundayPage brief={p?.brief ?? null} names={p?.capture.names ?? {}} busy={busy} problem={alsoProblems[s.planId] ?? ""} sender="" connected={connected} configured
        hasRecording={false} canReword={modelReady} decisions={decided} onDecisions={next => { if (key) setAlsoDecisions(key, next); }} operations={ops?.operations ?? null}
        onCheck={() => { void check(); }} onRecording={() => undefined} onExample={showExample} feedback={feedback} onSettings={() => setPage("connection")}
        people={{ granted: operationsGranted(status), onAdd: () => setPage("connection") }} asked={p ? askedSlotFor(p.brief, askedLinesFor(p.brief, p.capture.names)) : null}
        whoCouldHelp={p ? whoCouldHelpIn(p, decided) : undefined} focus={focusFor(s.planId)} onFocused={() => setSundayFocus(null)}
        openInPlanningCenter={openInPlanningCenter} pane={mainRef} part={{ name: s.name, waiting: alsoWaiting[s.serviceTypeId] ?? null, opsWith: mainName ?? "your first service",
          roomsWith: roomsHolder(ops?.roomsWith) }}
        changes={p && alsoLive(p) ? changeSlot(p.capture.plan_id, p.brief.time_zone, s.name) : null} />
    </DayProvider> };
  }) : [];
  // Today says every service's "Looks good — I'll send it" marks; with several services read, each role with its own service
  // ("Greeter (Youth Night)") and each other service's under keys of its own (services-merge.ts partKey), so two services'
  // marks for a role of the same name read apart. With one service, exactly as before.
  const todayAsked: readonly AskedLine[] = others.length && !offPc ? [
    ...askedLinesFor(fictional ? null : brief, shownNames ?? {}, mainName),
    ...alsoParts.flatMap(p => askedLinesFor(p.brief, p.capture.names, p.service.name).map(l => ({ ...l, key: partKey(p.capture.plan_id, l.key) }))),
  ] : askedLines;
  /** The Services page: the one service's page as always, or, with more than one watched, every service in date order. */
  const servicesPage = (main: ReactNode): ReactNode => !servicesShown ? main
    : <ServicesPage counts={open} controls={<PageControls brief={harnessBrief} busy={busy} connected={connected} configured={configured} hasRecording={Boolean(latest)}
        onCheck={() => { void check(); }} onRecording={() => { if (latest) void act(() => sundaySource.loadRecording(org, latest.path_id)); }} onExample={showExample}
        checking={checkingSaved && !connected} stuck={checkStuck ? checkConnection : null} adding={addingAccess || reconnecting} onSetUp={() => openSetup()}
        onSettings={() => setPage("connection")} problem={problem} refused={refused} summary={open ? acrossText(open, 1 + otherParts.length) : undefined} />}
      parts={[{ key: "main", date: brief?.plan.date ?? planDate(watchedDay.get(settings.planId)?.sort_date ?? null), dayText: day.date, node: main }, ...otherParts]} watch={pcWatch} />;
  return <DayProvider value={day}><SystemWordsContext.Provider value={onSystem || onGenesis ? words : nothingChosen && !fictional ? NOT_CHOSEN : systemWords(null)}><ListsSystemName.Provider value={words.name}>
    {/* Teams named with their service while more than one is watched (team-labels.ts): Church rules and Church lists. */}
    <TeamServicesContext.Provider value={serviceOfTeam}><FindingServicesContext.Provider value={findingServiceNames}><AlsoOperationsContext.Provider value={alsoOpsWords}><ListsTeamServices.Provider value={listsTeamServices}>
    <ChooseAiContext.Provider value={chooseAi}><div className={`oz app${dark ? " dark" : ""}`}>
    {/* One polite status line for the whole app, outside the shell (accessibility audit S4): announce.tsx. */}
    <Announcer>
    <div className={`shell ${askOpen ? "shell-ask" : "shell-2"}`}>
      <aside ref={side} className={`side${menu ? " is-menu" : ""}`} inert={askCovers}>
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
          <p className="quiet-note"><Icon name="lock" small /><span className="nav-label">{changesShownOn ? SIDEBAR_ON
            : `${promise("readsShort", offPc ? "A" : BUILD_FORM)} The names Ozzie reads stay on this Mac.`}</span></p>
          <p className="small side-org">{churchLine}</p>
          {/* AI and Ask wait for the first result: before it, nothing should pull a person off the one step that matters. */}
          {askShown && <div className="small side-ai"><AiLine status={modelStatus} small onChange={chooseAi} /></div>}
        </div>
        </div>
        {askShown && <button type="button" ref={askEntry} className="btn btn-secondary ask-entry" aria-expanded={askOpen} aria-controls="ask-panel"
          onClick={() => { setMenu(false); setAskOpen(!askOpen); }}><AskIcon /><span className="nav-label">Ask Ozzie</span></button>}
      </aside>
      <main className="main" ref={mainRef} inert={askCovers}>
        {showSetup && choosing && <ChooseSystem onChoose={to => { sys.setState({ ...sys.state, main: to }); setSetupKey(k => k + 1); setSetup("first"); }}
          onExample={() => { setupMemo.set({ exampleSeen: true }); leaveSetup("sunday"); showExample(); }} />}
        {showSetup && !choosing && onSystem && <SystemFirstRun key={setupKey} state={sys.state} onState={sys.setState} start={setup === "service" ? "service" : "connect"}
          read={c => sys.check(c)} result={systemResult} day={day} aiOffered={setupMemo.get().aiOffered} nowMs={Date.parse(now)} bridge={churchSystems}
          renderAi={done => <AiChoice mode="first-run" onModel={setModelReady} onDone={how => { setupMemo.set({ aiOffered: true, ...(how ? { aiAnswer: how } : {}) }); done(how); }}
            onCheckSetup={() => { done(); setChecking(true); }} />}
          onLeave={to => leaveSetup(to)} onChooseAgain={() => { setChoseAgain(true); sys.setState({ ...sys.state, main: null, connection: null, choosing: true }); setSetupKey(k => k + 1); setSetup("first"); }}
          onExample={() => { setupMemo.set({ exampleSeen: true }); leaveSetup("sunday"); showExample(); }} refusal={refusalLine(onSystem, sys.refusal)} />}
        {showSetup && !choosing && onGenesis && <GenesisFirstRun key={setupKey} state={sys.state} onState={sys.setState} nowMs={Date.parse(now)} aiOffered={setupMemo.get().aiOffered}
          read={at => genesis.read("manual", at)} intervalMinutes={automatic.prefs.intervalMinutes}
          shown={{ capture: genesis.capture, view: genesis.view, busy: genesis.busy, problem: genesis.problem }}
          renderAi={done => <AiChoice mode="first-run" onModel={setModelReady} onDone={how => { setupMemo.set({ aiOffered: true, ...(how ? { aiAnswer: how } : {}) }); done(); }}
            onCheckSetup={() => { done(); setChecking(true); }} />}
          onLeave={to => leaveSetup(to)}
          onChooseAgain={() => { setChoseAgain(true); sys.setState({ ...sys.state, main: null, choosing: true }); setSetupKey(k => k + 1); setSetup("first"); }}
          onExample={() => { setupMemo.set({ exampleSeen: true }); leaveSetup("sunday"); showExample(); }} />}
        {showSetup && !choosing && !onSystem && !onGenesis && <FirstRun key={setupKey} start={setup} status={status} settings={settings} onSettings={setSettings} onStatus={setStatus}
          onWatching={(plan, zone, service) => { watchedDay.set(plan.id, plan.sort_date, plan.times, zone, service); setWatchVersion(v => v + 1); }}
          read={firstRead} result={firstResult} again={recordings.length > 0} rules={hasRules} intervalMinutes={automatic.prefs.intervalMinutes} nowMs={Date.parse(now)} memory={setupMemo}
          cards={openCards} onDiscardCards={discardCards} onLeave={to => leaveSetup(to)} onDeferred={() => setServiceDeferred(true)}
          renderAi={done => <AiChoice mode="first-run" onModel={setModelReady} onDone={how => done(how)} onCheckSetup={() => { done(); setChecking(true); }} />}
          onExample={() => { leaveSetup("sunday"); showExample(); }} onDisconnectTried={() => setDisconnectTries(n => n + 1)} />}
        {!showSetup && fictional && <ExampleBand onLeave={leaveExample} onSetUp={() => { leaveExample(); openSetup(); }} />}
        {!showSetup && aiChoosing && <div className="col"><AiFlow key={aiOpened} mode="settings" onModel={setModelReady} start={aiStart}
          backTo={backToName(page, day)}
          onDone={how => { if (how !== "later") setupMemo.set({ aiOffered: true, aiAnswer: how }); setAiChoosing(false); readModel(); if (page === "connection") setSettingsAt("ai-title"); }}
          onCheckSetup={() => { setAiChoosing(false); setChecking(true); }} /></div>}
        {!showSetup && !aiChoosing && checking && <div className="col">
          <CheckMySetup known={setupKnown} serviceTypeId={offPc ? undefined : settings.serviceTypeId || undefined} planId={offPc ? undefined : settings.planId || undefined}
            planDate={offPc ? undefined : (ofWatched?.plan.date ?? watchedDay.get(settings.planId)?.sort_date?.slice(0, 10)) || undefined}
            onConnect={() => { setChecking(false); openSetup(offPc || nothingChosen ? "first" : "browser"); }} onChooseService={() => { setChecking(false); openSetup("service"); }}
            onChangeAi={openAi} onOpenNotices={() => { void onboarding.openNoticeSettings().catch(() => { setChecking(false); setPage("connection"); }); }}
            onTurnOnStart={() => answerStart(true)} onPhone={() => { setChecking(false); setPage("connection"); }} onCheckAgain={readModel} zone={macZone()} />
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
        {/* Today counts and names every service watched, as the Services page does (services-merge.ts). */}
        {page === "today" && <DayProvider value={others.length && !offPc ? MANY_SERVICES : day}><TodayPage brief={harnessBrief} names={offPc ? shownNames : harnessCapture?.names} sundayDecisions={harnessDecisions} operations={operations} onSunday={() => setPage("sunday")}
          services={1 + others.length}
          // Jobs read Planning Center checks only: a church on another system has none running (each waits; Keeping watch says so).
          watch={fictional || offPc ? null : { view: watch, now, onAutomatic: () => setPage("automatic"), onOpen: setPage }} feedback={feedback} example={fictional} now={now}
          // Genesis: its own connection decides, never Planning Center's (review of e9cbd97d, H1).
          notConnected={onGenesis ? (!sys.state.genesis && !fictional ? { onConnect: () => openSetup("first"), onExample: showExample } : null)
            : onSystem ? (!systemConnected && !fictional ? { onConnect: () => openSetup("first"), onExample: showExample } : null)
            : !stillConnected && !fictional && !checkingSaved && !checkStuck ? { onConnect: () => openSetup(nothingChosen ? "first" : "browser"), onExample: showExample } : null}
          checking={checkingSaved && !connected} stuck={checkStuck ? checkConnection : null}
          regular={fictional ? null : onGenesis ? genesisRegular : regular} asked={todayAsked} onSundayCard={key => { setSundayFocus(key); setPage("sunday"); }}
          startQuestion={null}
          finish={!fictional && (onSystem ? systemConnected : onGenesis ? Boolean(sys.state.genesis) : stillConnected) ? <FinishSettingUp facts={finishFacts} startFailed={startFailed} onStartWithMac={answerStart}
            onChooseService={() => openSetup("service")} onKidsRules={() => setPage("rules")} onChooseAi={openAi}
            moreBody={<ReadMore {...moreProps} place="today" />} /> : undefined}
          waiting={fictional || onGenesis ? null : onSystem ? systemWaiting ?? (systemShown ? refusalLine(onSystem, sys.refusal) : null)
            : waitingLine ?? (connected && !configured && serviceLook === "waiting" ? waitingText(null) : null)}
          moment={fictional ? undefined : movedLine && Date.now() - movedLine.at < 86_400_000 ? <p className="banner" role="status"><Icon name="check" small /><span>{movedLine.line}</span></p>
            : phoneMomentNow(momentsNow.noticeSent, false) ? <PhoneMoment onSetUp={() => setPage("connection")} /> : undefined}
          church={onGenesis ? undefined : <ChurchReadsToday capture={capture} rules={rules} names={capture?.names} feedback={feedback} now={now} />}
          serviceLess={onGenesis ? <GenesisToday capture={genesisShown.capture} view={genesisShown.view} onOpen={() => setPage("sunday")} problem={fictional ? "" : genesis.problem} /> : null}
          calendar={!fictional && calendarsConnected(calendarState) ? { reads: calendarState.reads, reading: calendarState.reading, onSettings: () => setPage("connection") } : null} /></DayProvider>}
        {/* A church on B1 Church or Breeze: its own check, connection and facts, and none of Planning Center's extras. */}
        {page === "sunday" && onGenesis && <GenesisPage capture={genesisShown.capture} view={genesisShown.view} busy={genesis.busy} problem={fictional ? "" : genesis.problem}
          onCheck={() => { void genesis.read("manual"); }} fictional={fictional} connected={Boolean(sys.state.genesis?.zone)} onSetUp={() => openSetup("first")} />}
        {page === "sunday" && !onGenesis && resultsElsewhere}
        {page === "sunday" && !onGenesis && servicesPage(<SundayPage brief={brief} names={shownNames ?? {}} busy={systemShown ? sys.busy : busy}
          part={servicesShown ? { name: mainName, waiting: waitingLine, roomsWith: roomsHolder(mainRoomsWith) } : undefined}
          problem={systemShown ? (systemAsking ? keychainAsking(words.name) : sys.problem) : servicesShown ? "" : problem} sender=""
          connected={onSystem ? systemConnected : connected} adding={!onSystem && (addingAccess || reconnecting)} configured={onSystem ? systemConfigured : configured}
          hasRecording={onSystem ? Boolean(sys.latestSaved) && !sys.saved : Boolean(latest)} canReword={modelReady} checking={!onSystem && checkingSaved && !connected}
          stuck={!onSystem && checkStuck ? checkConnection : null}
          decisions={decisions} onDecisions={setDecisions} operations={operations}
          onCheck={onSystem ? systemCheck : () => { void check(); }}
          onRecording={onSystem ? () => { void sys.showSaved(); } : () => { if (latest) void act(() => sundaySource.loadRecording(org, latest.path_id)); }}
          onExample={showExample}
          onLaterExample={fictional && capture?.completed_at === nov22Capture().completed_at
            ? () => { void act(() => Promise.resolve(withFictionalOperations(nov22LaterCapture())), true); } : undefined}
          whoCouldHelp={onSystem === "breeze" ? undefined : whoCouldHelp} feedback={feedback} onSettings={() => setPage("connection")} refused={!onSystem && refused} onSetUp={() => openSetup()}
          people={onSystem ? null : { granted: operationsGranted(status), onAdd: () => setPage("connection") }} asked={askedSlot} focus={sundayFocus && !fromPartKey(sundayFocus) ? sundayFocus : null} onFocused={() => setSundayFocus(null)}
          openInPlanningCenter={fictional || onSystem ? null : openInPlanningCenter} pane={mainRef} changes={changesOnSunday}
          uncheckedLine={systemShown && onSystem ? refusalLine(onSystem, sys.refusal) : null}
          worthALook={systemShown && sys.connection ? <SystemNotices connection={sys.connection} capture={sys.capture} notices={sys.built?.notices ?? []}
            waitingForZone={sys.built?.coverage.waiting_for_zone ?? false} refusal={sys.refusal}
            onZone={zone => { const next = { ...sys.connection!, zone }; sys.setState({ ...sys.state, connection: next }); void sys.check(next); }} />
            : kidsToAsk ? <KidsQuestion teamId={kidsToAsk.id} teamName={kidsTeamName(kidsToAsk.name ?? "This team", serviceOfTeamFor(kidsToAsk.id, serviceOfTeam))}
            onYes={id => setRules(r => markKidsTeam(r, id, kidsToAsk.name ?? ""))} /> : undefined}
          // A church system's groups, events and forms: folded closed at the very bottom, one line until opened (round 4).
          last={onSystem && systemShown && sys.capture ? <section className="stack" aria-labelledby="system-also-title">
            {/* A heading for heading navigation, the fold's own line showing what it holds (review of round 4, L8). */}
            <h2 id="system-also-title" className="sr-only">Also read from {words.name}</h2>
            <SystemFactsList capture={sys.capture} zone={sys.connection?.zone ?? null} /></section>
            : !servicesShown && pcWatch ? <section className="stack" aria-labelledby="services-watch-title"><h2 id="services-watch-title" className="h3">Which services Ozzie watches</h2>{pcWatch}</section> : undefined}
          church={onSystem ? undefined : <CheckInsSunday capture={capture} rules={rules} names={capture?.names ?? {}} feedback={feedback} now={now} />}
          more={!onSystem && ofWatched && capture ? <ReadMore {...moreProps} place="service" reads={capture.reads} onCheck={() => { void check(); }} /> : undefined}
          beside={card => <ChurchOwnWords state={sourcesState} card={card} onOpen={target => { churchSources.focus(target); setPage("lists"); }} />} />)}
        {page === "rules" && <RulesPage rules={rules} onChange={setRules} positions={positions} keptElsewhere={Object.entries(rulesByChurch.kept).map(([organization, k]) => ({ organization, ...(k.name ? { name: k.name } : {}) }))}
          leaders={capture ? teamLeaders(capture) : {}} names={capture?.names ?? {}} rooms={capture ? captureRooms(capture) : []}
          procedures={orderedProcedures} focus={focusProcedure} church={onSystem || onGenesis ? null : <ChurchReadsRules rules={rules} onChange={setRules} capture={capture} status={status} />}
          procedureDay={others.length && !offPc ? MANY_SERVICES : undefined} />}
        {page === "lists" && <ChurchListsPage sources={churchSources} positions={positions} />}
        {page === "automatic" && onSystem && <ProactivePage view={automatic} names={sys.capture?.names ?? {}} organization={systemChurchKey ?? ""} planId={sys.connection?.service_id ?? ""}
          church={sys.connection?.church_name ?? null} readiness={systemReadiness} busy={sys.busy} now={now}
          churchTimeZone={sys.capture?.church.time_zone ?? sys.connection?.zone ?? null}
          onCheckNow={systemCheck} onPause={() => systemProactive.pause()} onResume={() => systemProactive.resume()} onPrefs={setPrefs}
          note={words.notHere(`${keepTitle()}, the morning briefing and other jobs`, true)} notReady={systemNotReady} />}
        {page === "automatic" && onGenesis && <GenesisWatch intervalMinutes={automatic.prefs.intervalMinutes} capture={genesis.capture} problem={genesis.problem} paused={automatic.schedule.paused}
          onPause={() => systemProactive.pause()} onResume={() => systemProactive.resume()} />}
        {page === "automatic" && !onSystem && !onGenesis && <ProactivePage view={automatic} names={changeNames} organization={org} planId={settings.planId} church={inUse?.name ?? null}
          readiness={readiness} shownReadiness={shownReadiness} busy={busy} now={now} churchTimeZone={churchZone}
          onCheckNow={() => { void check(); }} onPause={() => proactive.pause()} onResume={() => proactive.resume()} onPrefs={setPrefs} several={servicesShown}
          responsibilities={regular => <ResponsibilityList view={watch} context={planContext} runner={runner} actions={planActions} sunday={regular} names={changeNames} />} />}
        {page === "activity" && <ActivityPage capture={capture} notGranted={!offPc && (operationsAsked.get() || operationsReads.on === true) && Boolean(status?.scopes) && !operationsGranted(status)}
          tasks={tasks} procedures={procedures} trigger={triggers.get} end={triggers.end} found={triggers.found} source={triggers.source} parts={triggers.parts} ollama={ollamaDone}
          service={triggers.service} serviceNames={servicesShown ? Object.fromEntries([[settings.serviceTypeId, mainName], ...also.map(x => [x.serviceTypeId, x.name] as const)]
            .filter((e): e is [string, string] => Boolean(e[1]))) : {}}
          system={onSystem ? { name: words.name, check: sys.capture } : onGenesis ? { name: words.name, check: genesis.capture } : null}
          changes={!offPc && (changesOn || (changes.history?.length ?? 0) > 0)
            ? { lede: changesShownOn ? ACTIVITY_LEDE_ON : null, section: <ChangeHistory records={changes.history} names={historyNames} services={serviceNamesById} /> } : undefined} />}
        {page === "connection" && <ConnectionPage
          system={onSystem && sys.connection ? <SystemSettings connection={sys.connection} onConnection={next => { sys.setState({ ...sys.state, connection: next });
            if (next.service_id !== sys.connection?.service_id || next.zone !== sys.connection?.zone) void sys.check(next); }}
            onForget={() => { void forgetSystemChecks(); sys.forgetCheck(); forgetMovedLine(); sys.setState({ ...sys.state, connection: null }); }} onConnect={() => openSetup("first")}
            startsAt={sys.capture?.service?.starts_at ?? null} systemZone={sys.capture?.church.time_zone ?? null} />
            : onSystem ? <section className="settings-sec" aria-labelledby="pco-title"><h2 id="pco-title" className="h3" tabIndex={-1}>{words.name} and which service Ozzie watches</h2>
              <div className="find"><p className="find-body">{words.notConnected}.</p><div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={() => openSetup("first")}>{words.connect}</button></div></div></section>
            // Genesis as the main system (round 5): its church, zone, reading now and letting the key go.
            : onGenesis ? <GenesisSettings connection={sys.state.genesis} busy={genesis.busy} onRead={() => { void genesis.read("manual"); }} onConnect={() => openSetup("first")}
              onConnection={next => sys.setState({ ...sys.state, genesis: next ? { ...next, result_seen: true } : null })} />
            // Nothing chosen yet (round 5): the way to choose, in place of Planning Center's sign-in.
            : nothingChosen ? <section className="settings-sec" aria-labelledby="pco-title"><h2 id="pco-title" className="h3" tabIndex={-1}>What your church uses</h2>
              <div className="find"><p className="find-body">{NOT_CHOSEN.notConnected}. {promise("systemsRead")}</p>
                <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={() => openSetup("first")}>{NOT_CHOSEN.connect}</button></div></div></section>
            : undefined}
          watched={pcWatch}
          changes={connected && !offPc ? { section: <ChangesSwitch control={changes} church={inUse?.name ?? null} people={peopleOk} />, banner: changesShownOn ? SETTINGS_BANNER_ON : null } : undefined}
          onDisconnectTried={() => setDisconnectTries(n => n + 1)}
          others={<OtherSystems state={sys.state} onSwitch={switchSystem} cards={openCards}
            genesis={onGenesis ? null : <GenesisAlsoRead also={sys.state.genesis} onAlso={genesis => sys.setState({ ...sys.state, genesis })} />} />}
          openAt={settingsAt} onOpenAt={() => setSettingsAt(null)} status={status} kept={keptConnection} settings={settings} onSettings={setSettings} onStatus={setStatus}
          onPlanService={(planId, name) => { watchedDay.named(planId, name); setWatchVersion(v => v + 1); }} cards={openCards} onDiscardCards={discardCards}
          // On another system, Planning Center's saved checks kept from before a switch count too: they hold names (release review L2).
          recordingCount={onSystem ? sys.savedChecks.length + recordings.length : recordings.length} onModel={setModelReady} onAiAnswer={how => setupMemo.set({ aiOffered: true, aiAnswer: how })} prefs={automatic.prefs}
          developer={debug ? { loop, onLoop: next => { devLoop.set(next); setLoop(next); } } : undefined}
          sharing={sharing.settings} siri={shortcuts.settings} updates={<UpdatesSection state={updateState} nowMs={Date.parse(now)} cards={openCards} />} calendars={<CalendarSettings calendars={calendars} />}
          onAutomatic={() => setPage("automatic")} onSetup={() => openSetup()} onCheckSetup={() => setChecking(true)} onLists={() => setPage("lists")} autostart={autostart}
          onDeleteRecordings={() => { sharing.forget(); shortcuts.forget(); runner.forgetAllWriteups();
            // A church on another system: its own saved checks, and Planning Center's kept from before a switch.
            if (onSystem) {
              void forgetSystemChecks().finally(() => { sys.refreshSaved(); if (sys.saved) sys.forgetCheck(); });
              if (org && recordings.length) void sundaySource.deleteRecordings(org).finally(refreshRecordings);
            }
            else if (org) void sundaySource.deleteRecordings(org).finally(() => { refreshRecordings(); if (capture?.kind === "recording") setCapture(null); }); }} />}
        </>}
        {/* Outside the pages above, so guided setup or another page never unmounts it: the cards end only as KeptCards
            says (cards-page.tsx), and names beside them come only from a check of the church in use. */}
        {(page === "cards" || cardsOpened) && <div hidden={showSetup || page !== "cards"} className="cards-kept">
          <KeptCards check={onSystem ? sys.capture && { organization: SYSTEM_CARDS, names: sys.capture.names } : capture && { organization: capture.organization, names: capture.names }}
            example={fictional} inUse={onSystem ? (sys.connection ? SYSTEM_CARDS : null) : onGenesis ? (sys.state.genesis ? SYSTEM_CARDS : null) : inUseOrg ?? null}
            discarded={cardsDiscarded} onScreen={visible} onOpenCards={setOpenCards}
            disconnected={onSystem ? !systemConnected : onGenesis ? !sys.state.genesis : status?.state === "disconnected"} signInAgain={!offPc && needsSignIn(status)}
            noNames={onGenesis ? "Genesis gives Ozzie no one's name, so no possible matches are shown." : null} /></div>}
      </main>
      {quitAsk && <QuitQuestion ask={{ ...quitAsk, checks: checksNow }} undo={changes.undoable.length ? quitUndo(changes.undoable) : null} onKeep={() => { setQuitAsk(null); quitting.keep(); }} onQuit={() => { void quitting.quit().catch(() => setQuitAsk(null)); }} />}
      {/* Over the page, Ask dims what it makes unusable; a click there or Escape closes it (review of 0.6.1: the page
          looked usable and didn't answer the mouse). */}
      {askCovers && <div className="ask-shade" aria-hidden="true" onClick={closeAsk} />}
      <AskPanel key={onSystem ? `${systemChurchKey ?? onSystem}` : onGenesis ? `genesis:${sys.state.genesis?.church_id ?? "none"}` : askChurch.current ?? "none"} open={askOpen} onClose={closeAsk} ask={ask} brief={askBrief} services={chipServices} settled={chipSettled} chipFindings={chipFindings} modelReady={modelReady} onOpen={setPage}
        connection={onSystem ? (systemConnected ? "connected" : "not-connected") : onGenesis ? (sys.state.genesis ? "connected" : "not-connected") : stillConnected ? "connected" : checkingSaved ? "checking" : checkStuck ? "unchecked" : "not-connected"}
        page={showSetup ? "setup" : page} {...(onGenesis ? { answerHere: (typed: string) => genesisAnswer(typed, genesisShown.capture, genesisShown.view, fictional),
          // What was read decides what Ask offers on Genesis, never Planning Center's check (review of e9cbd97d, M1).
          here: { checked: Boolean(genesisShown.capture), chips: genesisQuestions(genesisShown.view) } } : {})}
        {...(onSystem || onGenesis ? { jobsNotHere: { parse: plans.parse, text: words.notHere(`${keepTitle()}, the morning briefing and other jobs`, true) } } : { plans })} />
    </div>
    </Announcer>
  </div></ChooseAiContext.Provider></ListsTeamServices.Provider></AlsoOperationsContext.Provider></FindingServicesContext.Provider></TeamServicesContext.Provider></ListsSystemName.Provider></SystemWordsContext.Provider></DayProvider>;
}
