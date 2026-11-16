import { shouldRefreshStale } from "./stale-refresh.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  connection, followInUse, foundOrganization, fresher, operationsAsked, operationsGranted, parseInUse, parseSwitchQuestion, pendingSettings, seenInUse, yourName,
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
import { applyDecisions, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { SundayPage, useSundayDecisions } from "./sunday-page.js";
import { RulesPage } from "./rules-page.js";
import { ActivityPage } from "./activity-page.js";
import { ConnectionPage } from "./connection-page.js";
import { TodayPage } from "./today-page.js";
import { sundayCount, sundayCountText } from "./today-groups.js";
import { Icon } from "./icons.js";
import { model } from "./model.js";
import { devChurchRules, devKidsRules, responsibilityAutopilot, runAutopilot } from "./autopilot.js";
import { loadRules, loadSettings, saveRules, saveSettings, sundayProblem, sundaySource, type RecordingSummary } from "./sunday-source.js";
import { browserStore, desktopProactive, proactiveReadiness, verifySavedOnLaunch, type ProactiveHooks } from "./proactive.js";
import { ProactivePage, useProactiveView } from "./proactive-page.js";
import { AskIcon, AskPanel, type AskFn, type PlanHooks } from "./ask-panel.js";
import type { Skill } from "../../../core/src/harness/contract.js";
import type { HarnessData } from "../../../core/src/harness/index.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { parseRequest } from "../../../core/src/harness/responsibilities.js";
import {
  askOzzie, buildHarnessData, createAppHarness, desktopRecorder, devLoop, enableDebugLines, grantedFor, localTriggers, procedures as loadProcedures,
  PROCEDURE_ORDER, shownAnswer, type LoopChoice,
} from "./harness-bridge.js";
import { modelSteps, type TaskRow } from "./harness-words.js";
import { CardsPage } from "./cards-page.js";
import { SetupFlow, setupMemory } from "./setup-flow.js";
import { invoke } from "@tauri-apps/api/core";
import { autostart, background, startProbe } from "./background.js";
import { createRunner, handChanges, nativeResponsibilities, responsibilityStep, type RunnerHooks } from "./responsibility-runner.js";
import { ResponsibilityList, useRunnerView, type PlanActions, type PlanContext } from "./responsibility-views.js";
import { feedbackOf } from "../../../core/src/finding-feedback.js";
import type { FeedbackSource } from "./finding-feedback.js";
import { useSharing } from "./share-check.js";
import { useOpenedPage, useShortcuts } from "./siri-shortcuts.js";
import { updates, useUpdates } from "./updates.js";
import { UpdateLine, UpdatesSection } from "./updates-view.js";
import { calendarsConnected, createCalendars, useCalendarState } from "./calendars.js";
import { CalendarSettings } from "./calendar-settings.js";

type Page = "today" | "sunday" | "cards" | "rules" | "automatic" | "activity" | "connection";
const nav: { id: Page; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "clock" }, { id: "sunday", label: "Sunday", icon: "sun" }, { id: "cards", label: "Visitor cards", icon: "user" },
  { id: "rules", label: "Church rules", icon: "rules" },
  { id: "automatic", label: "What runs automatically", icon: "repeat" },
  { id: "activity", label: "What happened", icon: "history" }, { id: "connection", label: "Settings", icon: "link" },
];
const proactive = desktopProactive();
// What Ozzie keeps an eye on (responsibility-runner.ts): one per webview, like the Sunday schedule.
// Debug builds only: a fast schedule and name-free lines for the developer's terminal.
const debugRunner = { fast: false, lines: false };
const runner = createRunner({
  native: nativeResponsibilities(), store: browserStore, now: () => new Date().toISOString(),
  notify: background.notify, nextDue: background.nextDue, fast: () => debugRunner.fast,
  log: line => { if (debugRunner.lines) void invoke("dev_log", { line }).catch(() => undefined); },
});
const macZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Whether the window is on screen: being "seen in Ozzie" needs a person who can see it. */
function useWindowVisible(): boolean {
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const [shown, setShown] = useState(visible);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const changed = () => setShown(visible());
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return shown;
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

export function App() {
  const [page, setPage] = useState<Page>("today");
  const [status, setShownStatus] = useState<ConnectionStatus | null>(null);
  // Native statuses carry a revision: one read before an answer but arriving after it is ignored (review S, L5).
  const newestStatus = useRef(0);
  const setStatus = useCallback((next: ConnectionStatus | null) => {
    if (!fresher(next, newestStatus.current)) return;
    if (next?.revision !== undefined) newestStatus.current = next.revision;
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
  const [now, setNow] = useState(() => new Date().toISOString());
  const [modelReady, setModelReady] = useState(false);
  // Guided setup: shown on its own until skipped or finished; Settings can reopen it.
  const [setup, setSetup] = useState<"auto" | "open" | "closed">(() => setupMemory.closed() ? "closed" : "auto");
  const [launched, setLaunched] = useState(false);
  // The debug-only hidden-window probe and stand-in update test never read the Keychain (where the AI key lives).
  useEffect(() => {
    void Promise.all([background.info(), updates.status().catch(() => null)]).then(([info, update]) => {
      if (!info.probe && !update?.probe) model.status().then(s => setModelReady(s.configured)).catch(() => setModelReady(false));
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
  // Ask Ozzie: docked beside the work column on a wide window, otherwise opened on request.
  // One set of placeholder labels for the whole app, so a person or role keeps its label across questions.
  const [harnessSession] = useState(() => new HarnessSession());
  const [askOpen, setAskOpen] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1440px)").matches);
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
  const [ledgerVersion, setLedgerVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    const update = () => connection.status().then(v => { if (alive) setStatus(v); }).catch(() => undefined);
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
  const refreshRecordings = () => { if (org) sundaySource.recordings(org).then(setRecordings).catch(() => setRecordings([])); else setRecordings([]); };
  useEffect(refreshRecordings, [org]);
  useEffect(() => saveSettings(settings), [settings]);
  // Scheduled checks read the latest app state through refs; they never change what the person typed.
  const current = useRef({ settings, rules, status, fictional, refreshRecordings, inUseOrg });
  current.current = { settings, rules, status, fictional, refreshRecordings, inUseOrg };
  // A live check is acted on only if it is of the church Ozzie uses now: one that finishes, or is shared, after a switch
  // is dropped by every consumer (review S2, L1).
  const belongs = (c: SundayCapture) => ofChurchInUse(c, current.current.settings.organization, current.current.inUseOrg);
  const automatic = useProactiveView(proactive);
  const hooks: ProactiveHooks = useMemo(() => ({
    context: () => current.current,
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
  // Run a due check as soon as a saved connection and a chosen Sunday are known, not at the next timer tick.
  const readiness = proactiveReadiness(settings, status);
  useEffect(() => { if (readiness === "ready") { void proactive.tick(); void runner.tick(); } }, [readiness]);
  // What Ozzie keeps an eye on reads the latest app state through refs, like the Sunday schedule.
  const watch = useRunnerView(runner);
  useEffect(() => { if ((page === "automatic" || page === "today") && visible) runner.markSeen(); }, [page, watch.unseen, visible]);
  // Today in front: read the calendars again once the last read is over 15 minutes old (checked as the clock ticks).
  useEffect(() => { if (page === "today" && visible) void calendars.readIfOld(); }, [page, visible, calendars, now]);
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
    // With an AI model: the template's procedure through the harness, each step paid from this run's grant.
    prepare: async (r, grant, c, signal) => {
      const s = runnerState.current;
      if (!s.procedures || !belongs(c)) return null;
      const data = buildHarnessData({ capture: c, fictional: false, rules: s.rules, decisions: s.decisions, status: s.status, configured: s.configured, now: new Date().toISOString() });
      const h = createAppHarness({ workspace_id: s.workspace, data, skills: s.procedures, session: harnessSession, loop: s.loop, recorder: desktopRecorder(), step: responsibilityStep(grant.run_id) });
      const observer = desktopRecorder().task("skill", r.skill_id);
      // A pause aborts the run's signal, which stops the AI work at once (the loop cancels its step and tools).
      const outcome = await h.runSkill(r.skill_id, { onEvent: observer.onEvent, ...(signal ? { signal } : {}) });
      void desktopRecorder().idle().then(() => setLedgerVersion(v => v + 1));
      const ai_steps = modelSteps(outcome.events);
      if (outcome.status !== "verified" || !outcome.answer) return { status: outcome.status, code: outcome.code, summary: null, draft: null, ai_steps };
      const shown = shownAnswer(h, outcome, s.procedures.get(r.skill_id), "");
      return { status: "verified", code: null, summary: shown.body, draft: shown.draft, ai_steps };
    },
  }), [harnessSession]);
  // The native timer wakes the page (even with the window closed), reports Mac sleep, Pause everything
  // from the menu bar, and the window coming back (a briefing that was announced opens Today).
  useEffect(() => {
    const openToday = () => { if (runner.view().open_today && document.visibilityState !== "hidden") { setPage("today"); runner.clearOpenToday(); } };
    const stop = background.on({
      tick: () => { void runner.tick(); void proactive.tick(); },
      wake: (slept, at) => runner.wake(slept, at),
      // Pause everything takes effect at once; lifting it puts the Sunday check back as it was.
      paused: paused => { proactive.pauseWithEverything(paused); void runner.pausedElsewhere(paused); },
      shown: openToday,
    });
    document.addEventListener("visibilitychange", openToday);
    return () => { stop(); document.removeEventListener("visibilitychange", openToday); };
  }, []);
  // Fill only empty fields; never overwrite what the person entered.
  // Automatic checks start after this settles, so they never race the developer autopilot.
  useEffect(() => {
    const begin = () => { proactive.start(hooks); runner.start(runnerHooks); };
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
        setSetup("closed");
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
        void connection.status().then(current => verifySavedOnLaunch(merged(loadSettings()), current))
          .then(verified => {
            if (!verified) return;
            setStatus(verified);
            // The scheduler reads this ref on its first tick, before React re-renders.
            current.current = { ...current.current, status: verified };
          }).catch(() => undefined).finally(begin);
      }
    }).catch(begin).finally(() => setLaunched(true));
  }, []);
  useEffect(() => saveRules(savedRules), [savedRules]);

  const brief = useMemo(() => capture ? buildSundayBrief(capture, rules, fictional ? capture.completed_at : now, fictional) : null, [capture, rules, now, fictional]);
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
    ? (typed, signal) => askOzzie(harness, typed, { signal, recorder, skills: procedures, sender: yourName.get() })
      .finally(() => { void recorder.idle().then(() => setLedgerVersion(v => v + 1)); })
    : null, [harness, procedures, recorder]);
  // What happened reads the ledger when it opens, after each task, and every few seconds while it's open.
  useEffect(() => {
    if (page !== "activity") return;
    let alive = true;
    const load = () => { void recorder.list(50).then(rows => { if (alive) setTasks(rows); }); };
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [page, ledgerVersion, recorder]);
  const showProcedure = (id: string) => { setFocusProcedure(id); setPage("rules"); };

  const act = async (work: () => Promise<SundayCapture>, isFictional = false) => {
    setBusy(true); setProblem("");
    try { setCapture(await work()); setFictional(isFictional); setNow(new Date().toISOString()); }
    catch (error) { setProblem(sundayProblem(error)); }
    finally { setBusy(false); }
  };
  // Same check as always (re-verify a saved connection, then read), through the one path that
  // never runs two checks at once and remembers what changed.
  const check = () => act(() => proactive.checkNow());
  // First run: no saved Planning Center registration or no chosen Sunday on this Mac, decided once when launch settles.
  // It then stays open while the person fills it in, until they skip, finish or leave it.
  const needsSetup = !(org && configured);
  useEffect(() => { if (launched) setSetup(s => s === "auto" ? needsSetup ? "open" : "closed" : s); }, [launched]);
  const showSetup = setup === "open" || (setup === "auto" && launched && needsSetup);
  // A page an ozzie:// link opened (native accepts only Today and Sunday, while Siri and Shortcuts is on); ignored while
  // guided setup is showing, which a link never closes.
  const showingSetup = useRef(showSetup);
  showingSetup.current = showSetup;
  useOpenedPage(opened => { setFocusProcedure(null); setPage(opened); }, () => !showingSetup.current);
  useLayoutEffect(() => {
    if (focusProcedure) return;
    if (mainRef.current) mainRef.current.scrollTop = 0;
    if (typeof window !== "undefined" && typeof window.scrollTo === "function") window.scrollTo(0, 0);
  }, [page, showSetup, focusProcedure]);
  const endSetup = (then: Page) => { setupMemory.close(); setSetup("closed"); setPage(then); };
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
    organization: org, granted, modelReady, connected: readiness === "ready", zone: scheduleZone, now: () => new Date().toISOString(), sunday: chosenSunday,
    existing: watch.items, pausedAll: watch.paused_all,
  };
  const planActions: PlanActions = {
    start: plan => runner.create(plan), edit: (id, plan) => runner.edit(id, plan),
    onSettings: () => { setSetup("closed"); setPage("connection"); }, onAutomatic: () => setPage("automatic"),
  };
  // What the person tells Ozzie on finding cards: kept with the Church rules, applied to the check on screen and every later one.
  const feedback: FeedbackSource = { entries: feedbackOf(rules), onEntries: next => setRules(r => ({ ...r, feedback: next })) };
  // "Keep an eye on Sunday" in Ask becomes a plan to confirm: read here, with no model.
  const plans: PlanHooks = { parse: typed => parseRequest(typed, new Date().toISOString(), scheduleZone, { sunday: chosenSunday }), context: planContext, actions: planActions };
  const dark = useDarkAppearance();
  // Closing Ask puts keyboard focus back on the button that opens it, rather than nowhere.
  const askEntry = useRef<HTMLButtonElement>(null);
  const closeAsk = () => { setAskOpen(false); askEntry.current?.focus(); };
  // Things to decide, the same number as Today's Sunday card and the Sunday page (Worth a look is listed there, not counted here).
  const sundayBadge = sundayCount(open);
  const automaticCount = page !== "automatic" ? automatic.unseen + watch.unseen : 0;
  // A narrow window (or large text) shows the sidebar as icons; each label stays for VoiceOver and shows beside its icon on hover or keyboard focus.
  return <div className={`oz app${dark ? " dark" : ""}`}>
    <div className={`shell ${askOpen ? "shell-ask" : "shell-2"}`}>
      <aside className="side">
        <div className="brand"><img className="logo" src="/ozzie.svg" alt="Ozzie by FlockConnect" /></div>
        <nav className="nav">{nav.map(n => <a key={n.id} href={`#${n.id}`} className="nav-i" data-label={n.label} aria-current={!showSetup && page === n.id ? "page" : undefined}
          onClick={e => { e.preventDefault(); if (showSetup) setSetup("closed"); setFocusProcedure(null); setPage(n.id); }}><Icon name={n.icon} /><span className="nav-label">{n.label}</span>
          {n.id === "sunday" && sundayBadge > 0 && <span className="count"><span aria-hidden="true">{sundayBadge}</span>
            <span className="sr-only">, {sundayCountText(sundayBadge)}</span></span>}
          {n.id === "automatic" && automaticCount > 0 && <span className="count"><span aria-hidden="true">{automaticCount}</span>
            <span className="sr-only">, {automaticCount} new</span></span>}</a>)}</nav>
        <button type="button" ref={askEntry} className="btn btn-secondary ask-entry" aria-expanded={askOpen} aria-controls="ask-panel"
          onClick={() => setAskOpen(!askOpen)}><AskIcon /><span className="nav-label">Ask Ozzie</span></button>
        <div className="side-foot">
          <p className="quiet-note"><Icon name="lock" small /><span className="nav-label">Reads only. Names Ozzie reads stay on this Mac.</span></p>
          <p className="small side-org">{!connected ? "Planning Center not connected" : inUse?.name ? `Planning Center: ${inUse.name}` : `Planning Center organization ${status!.organization}`}</p>
        </div>
      </aside>
      <main className="main" ref={mainRef}>
        {showSetup && <SetupFlow status={status} settings={settings} onSettings={setSettings} onStatus={setStatus} prefs={automatic.prefs} onModel={setModelReady}
          onClose={() => endSetup("today")} onAutomatic={() => endSetup("automatic")}
          onExample={() => { endSetup("sunday"); void act(() => Promise.resolve(withFictionalOperations(nov22Capture())), true); }} />}
        {!showSetup && <>
        {switchQuestion && page !== "connection" && <SwitchWaiting question={switchQuestion} onOpen={() => setPage("connection")} />}
        {page === "today" && <UpdateLine state={updateState} nowMs={Date.parse(now)} />}
        {page === "today" && <TodayPage brief={brief} names={capture?.names} sundayDecisions={decisions} operations={operations} onSunday={() => setPage("sunday")}
          watch={{ view: watch, now, onAutomatic: () => setPage("automatic"), onOpen: setPage }} feedback={feedback} example={!connected && !calendarsConnected(calendarState)}
          church={<ChurchReadsToday capture={capture} rules={rules} names={capture?.names} feedback={feedback} now={now} />}
          calendar={calendarsConnected(calendarState) ? { reads: calendarState.reads, reading: calendarState.reading, onSettings: () => setPage("connection") } : null} />}
        {page === "sunday" && <SundayPage brief={brief} names={capture?.names ?? {}} busy={busy} problem={problem} sender=""
          connected={connected} configured={configured} hasRecording={Boolean(latest)} canReword={modelReady}
          decisions={decisions} onDecisions={setDecisions} operations={operations}
          onCheck={() => { void check(); }}
          onRecording={() => { if (latest) void act(() => sundaySource.loadRecording(org, latest.path_id)); }}
          onExample={() => { void act(() => Promise.resolve(withFictionalOperations(nov22Capture())), true); }}
          onLaterExample={fictional && capture?.completed_at === nov22Capture().completed_at
            ? () => { void act(() => Promise.resolve(withFictionalOperations(nov22LaterCapture())), true); } : undefined}
          onHow={procedures ? showProcedure : undefined} feedback={feedback} onSettings={() => setPage("connection")}
          church={<CheckInsSunday capture={capture} rules={rules} names={capture?.names ?? {}} feedback={feedback} now={now} />} />}
        {page === "cards" && <CardsPage people={capture?.names ?? {}} workspace={org || "this-mac"} />}
        {page === "rules" && <RulesPage rules={rules} onChange={setRules} positions={positions} keptElsewhere={Object.entries(rulesByChurch.kept).map(([organization, k]) => ({ organization, ...(k.name ? { name: k.name } : {}) }))}
          leaders={capture ? teamLeaders(capture) : {}} names={capture?.names ?? {}} rooms={capture ? captureRooms(capture) : []}
          procedures={orderedProcedures} focus={focusProcedure} church={<ChurchReadsRules rules={rules} onChange={setRules} capture={capture} status={status} />} />}
        {page === "automatic" && <ProactivePage view={automatic} names={changeNames} organization={org} planId={settings.planId}
          readiness={readiness} busy={busy} now={now} churchTimeZone={churchZone}
          onCheckNow={() => { void check(); }} onPause={() => proactive.pause()} onResume={() => proactive.resume()} onPrefs={p => proactive.setPrefs(p)}
          responsibilities={regular => <ResponsibilityList view={watch} context={planContext} runner={runner} actions={planActions} sunday={regular} />} />}
        {page === "activity" && <ActivityPage capture={capture} notGranted={operationsAsked.get() && Boolean(status?.scopes) && !operationsGranted(status)}
          tasks={tasks} procedures={procedures} trigger={triggers.get} />}
        {page === "connection" && <ConnectionPage status={status} settings={settings} onSettings={setSettings} onStatus={setStatus}
          recordingCount={recordings.length} onModel={setModelReady} prefs={automatic.prefs}
          developer={debug ? { loop, onLoop: next => { devLoop.set(next); setLoop(next); } } : undefined}
          sharing={sharing.settings} siri={shortcuts.settings} updates={<UpdatesSection state={updateState} nowMs={Date.parse(now)} />} calendars={<CalendarSettings calendars={calendars} />}
          onAutomatic={() => setPage("automatic")} onSetup={() => setSetup("open")} autostart={autostart}
          onDeleteRecordings={() => { sharing.forget(); shortcuts.forget(); if (org) void sundaySource.deleteRecordings(org).finally(() => { refreshRecordings(); if (capture?.kind === "recording") setCapture(null); }); }} />}
        </>}
      </main>
      <AskPanel key={askChurch.current ?? "none"} open={askOpen} onClose={closeAsk} ask={ask} brief={brief} modelReady={modelReady} onOpen={setPage}
        page={showSetup ? "setup" : page} plans={plans} />
    </div>
  </div>;
}
