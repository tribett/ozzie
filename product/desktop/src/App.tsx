import { useEffect, useMemo, useRef, useState } from "react";
import { connection, operationsAsked, type ConnectionStatus } from "./connection.js";
import "./hearth.css";
import "./styles.css";
import { buildSundayBrief, teamLeaders } from "../../../core/src/sunday-brief.js";
import { captureToCoverage, type SundayCapture } from "../../../core/src/sunday-capture.js";
import { nov22Capture, nov22LaterCapture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { captureRooms, sundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, openCount } from "../../../core/src/sunday-decisions.js";
import { SundayPage, useSundayDecisions } from "./sunday-page.js";
import { RulesPage } from "./rules-page.js";
import { ActivityPage } from "./activity-page.js";
import { ConnectionPage } from "./connection-page.js";
import { TodayPage } from "./today-page.js";
import { Icon } from "./icons.js";
import { model } from "./model.js";
import { runAutopilot } from "./autopilot.js";
import { loadRules, loadSettings, saveRules, saveSettings, sundayProblem, sundaySource, type RecordingSummary } from "./sunday-source.js";
import { desktopProactive, proactiveReadiness, type ProactiveHooks } from "./proactive.js";
import { ProactivePage, useProactiveView } from "./proactive-page.js";
import { AskSession } from "../../../core/src/ask.js";
import { AskIcon, AskPanel } from "./ask-panel.js";
import { CardsPage } from "./cards-page.js";
import { SetupFlow, setupMemory } from "./setup-flow.js";

type Page = "today" | "sunday" | "cards" | "rules" | "automatic" | "activity" | "connection";
const nav: { id: Page; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "clock" }, { id: "sunday", label: "Sunday", icon: "sun" }, { id: "cards", label: "Visitor cards", icon: "user" },
  { id: "rules", label: "Church rules", icon: "rules" },
  { id: "automatic", label: "What runs automatically", icon: "repeat" },
  { id: "activity", label: "What happened", icon: "history" }, { id: "connection", label: "Settings", icon: "link" },
];
const proactive = desktopProactive();

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
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [rules, setRules] = useState(loadRules);
  const [capture, setCapture] = useState<SundayCapture | null>(null);
  const [fictional, setFictional] = useState(false);
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [now, setNow] = useState(() => new Date().toISOString());
  const [modelReady, setModelReady] = useState(false);
  // Guided setup: shown on its own until skipped or finished; Settings can reopen it.
  const [setup, setSetup] = useState<"auto" | "open" | "closed">(() => setupMemory.closed() ? "closed" : "auto");
  const [launched, setLaunched] = useState(false);
  useEffect(() => { model.status().then(s => setModelReady(s.configured)).catch(() => setModelReady(false)); }, []);
  // Ask Ozzie: docked beside the work column on a wide window, otherwise opened on request.
  const [askSession] = useState(() => new AskSession());
  const [askOpen, setAskOpen] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1440px)").matches);

  useEffect(() => {
    let alive = true;
    const update = () => connection.status().then(v => { if (alive) setStatus(v); }).catch(() => undefined);
    void update();
    const timer = setInterval(() => { void update(); setNow(new Date().toISOString()); }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const org = /^[1-9]\d{0,31}$/.test(settings.organization) ? settings.organization : "";
  const refreshRecordings = () => { if (org) sundaySource.recordings(org).then(setRecordings).catch(() => setRecordings([])); else setRecordings([]); };
  useEffect(refreshRecordings, [org]);
  useEffect(() => saveSettings(settings), [settings]);
  // Scheduled checks read the latest app state through refs; they never change what the person typed.
  const current = useRef({ settings, rules, status, fictional, refreshRecordings });
  current.current = { settings, rules, status, fictional, refreshRecordings };
  const automatic = useProactiveView(proactive);
  const hooks: ProactiveHooks = useMemo(() => ({
    context: () => current.current,
    onStatus: setStatus,
    onCapture: (c, trigger) => {
      current.current.refreshRecordings();
      // A scheduled check shows its result unless the person is looking at the fictional example.
      if (trigger !== "manual" && !current.current.fictional) { setCapture(c); setNow(new Date().toISOString()); }
    },
  }), []);
  useEffect(() => () => proactive.stop(), []);
  useEffect(() => { if (page === "automatic") proactive.markSeen(); }, [page, automatic.unseen]);
  // Run a due check as soon as a saved connection and a chosen Sunday are known, not at the next timer tick.
  const readiness = proactiveReadiness(settings, status);
  useEffect(() => { if (readiness === "ready") void proactive.tick(); }, [readiness]);
  // Fill only empty fields; never overwrite what the person entered.
  // Automatic checks start after this settles, so they never race the developer autopilot.
  useEffect(() => {
    const begin = () => proactive.start(hooks);
    sundaySource.devDefaults().then(d => {
      const merged = (s: typeof settings) => ({
        clientId: s.clientId || d.clientId, organization: s.organization || d.organization,
        serviceTypeId: s.serviceTypeId || d.serviceTypeId, planId: s.planId || d.planId,
      });
      setSettings(merged);
      if (d.autopilot) {
        setSetup("closed");
        setPage("sunday");
        void runAutopilot(merged(loadSettings()), loadRules(), Boolean(d.autopilotOperations), c => { setCapture(c); setFictional(false); refreshRecordings(); })
          .then(() => model.status().then(s => setModelReady(s.configured)).catch(() => undefined))
          .finally(begin);
      } else begin();
    }).catch(begin).finally(() => setLaunched(true));
  }, []);
  useEffect(() => saveRules(rules), [rules]);

  const brief = useMemo(() => capture ? buildSundayBrief(capture, rules, fictional ? capture.completed_at : now, fictional) : null, [capture, rules, now, fictional]);
  const positions = useMemo(() => capture ? captureToCoverage(capture, rules, now).positions : [], [capture, rules, now]);
  const [decisions, setDecisions] = useSundayDecisions(capture, brief);
  const open = brief ? openCount(applyDecisions(brief, decisions)) : null;
  // Rooms, follow-ups and group meetings from the capture's own reads, on the church's own time zone
  // (the example's fictional church is on Eastern time). A fictional example is evaluated as of its own check.
  const operations = useMemo(() => capture ? sundayOperations(capture, rules, fictional ? {} : { now }) : null, [capture, rules, now, fictional]);
  const connected = (status?.state === "connected" || status?.state === "stored-unchecked") && Boolean(settings.clientId && settings.organization);
  const configured = /^\d+$/.test(settings.serviceTypeId) && /^\d+$/.test(settings.planId);
  const latest = recordings.filter(r => r.plan_id === settings.planId).sort((a, b) => b.completed_at.localeCompare(a.completed_at))[0];

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
  const needsSetup = !(settings.clientId && org && configured);
  useEffect(() => { if (launched) setSetup(s => s === "auto" ? needsSetup ? "open" : "closed" : s); }, [launched]);
  const showSetup = setup === "open" || (setup === "auto" && launched && needsSetup);
  const endSetup = (then: Page) => { setupMemory.close(); setSetup("closed"); setPage(then); };
  // Names for "What changed" come only from the current real check of the same organization.
  const changeNames = capture && !fictional && capture.organization === org ? capture.names : {};
  // The church's time zone as Planning Center Services gave it, from a real check of the same organization only.
  const churchZone = capture && !fictional && capture.organization === org ? brief?.time_zone ?? null : null;
  const dark = useDarkAppearance();

  return <div className={`oz app${dark ? " dark" : ""}`}>
    <div className={`shell ${askOpen ? "shell-ask" : "shell-2"}`}>
      <aside className="side">
        <div className="brand"><img className="logo" src="/ozzie.svg" alt="Ozzie by FlockConnect" /></div>
        <nav className="nav">{nav.map(n => <a key={n.id} href={`#${n.id}`} className="nav-i" aria-current={!showSetup && page === n.id ? "page" : undefined}
          onClick={e => { e.preventDefault(); if (showSetup) setSetup("closed"); setPage(n.id); }}><Icon name={n.icon} />{n.label}
          {n.id === "sunday" && open && open.decisions + open.looks > 0 && <span className="count">{open.decisions + open.looks}</span>}
          {n.id === "automatic" && page !== "automatic" && automatic.unseen > 0 && <span className="count">{automatic.unseen}</span>}</a>)}</nav>
        <button type="button" className="btn btn-secondary ask-entry" aria-expanded={askOpen} aria-controls="ask-panel" onClick={() => setAskOpen(!askOpen)}>
          <AskIcon />Ask Ozzie</button>
        <div className="side-foot">
          <p className="quiet-note"><Icon name="lock" small />Reads only. Names stay on this Mac.</p>
          <p className="small">{connected ? `Planning Center · org ${status!.organization}` : "Planning Center not connected"}</p>
        </div>
      </aside>
      <main className="main">
        {showSetup && <SetupFlow status={status} settings={settings} onSettings={setSettings} onStatus={setStatus} prefs={automatic.prefs} onModel={setModelReady}
          onClose={() => endSetup("today")} onAutomatic={() => endSetup("automatic")}
          onExample={() => { endSetup("sunday"); void act(() => Promise.resolve(withFictionalOperations(nov22Capture())), true); }} />}
        {!showSetup && <>
        {page === "today" && <TodayPage brief={brief} names={capture?.names} sundayDecisions={decisions} operations={operations} onSunday={() => setPage("sunday")} />}
        {page === "sunday" && <SundayPage brief={brief} names={capture?.names ?? {}} busy={busy} problem={problem} sender=""
          connected={connected} configured={configured} hasRecording={Boolean(latest)} canReword={modelReady}
          decisions={decisions} onDecisions={setDecisions} operations={operations}
          onCheck={() => { void check(); }}
          onRecording={() => { if (latest) void act(() => sundaySource.loadRecording(org, latest.path_id)); }}
          onExample={() => { void act(() => Promise.resolve(withFictionalOperations(nov22Capture())), true); }}
          onLaterExample={fictional && capture?.completed_at === nov22Capture().completed_at
            ? () => { void act(() => Promise.resolve(withFictionalOperations(nov22LaterCapture())), true); } : undefined} />}
        {page === "cards" && <CardsPage people={capture?.names ?? {}} workspace={org || "this-mac"} />}
        {page === "rules" && <RulesPage rules={rules} onChange={setRules} positions={positions}
          leaders={capture ? teamLeaders(capture) : {}} names={capture?.names ?? {}} rooms={capture ? captureRooms(capture) : []} />}
        {page === "automatic" && <ProactivePage view={automatic} names={changeNames} organization={org} planId={settings.planId}
          readiness={readiness} busy={busy} now={now} churchTimeZone={churchZone}
          onCheckNow={() => { void check(); }} onPause={() => proactive.pause()} onResume={() => proactive.resume()} onPrefs={p => proactive.setPrefs(p)} />}
        {page === "activity" && <ActivityPage capture={capture} notGranted={operationsAsked.get() && status?.scopes === "services"} />}
        {page === "connection" && <ConnectionPage status={status} settings={settings} onSettings={setSettings} onStatus={setStatus}
          recordingCount={recordings.length} onModel={setModelReady} prefs={automatic.prefs}
          onAutomatic={() => setPage("automatic")} onSetup={() => setSetup("open")}
          onDeleteRecordings={() => { if (org) void sundaySource.deleteRecordings(org).finally(() => { refreshRecordings(); if (capture?.kind === "recording") setCapture(null); }); }} />}
        </>}
      </main>
      <AskPanel open={askOpen} onClose={() => setAskOpen(false)} session={askSession} brief={brief} names={capture?.names ?? {}}
        organization={capture?.organization ?? ""} decisions={decisions} modelReady={modelReady} sender="" onOpen={setPage}
        page={showSetup ? "setup" : page} />
    </div>
  </div>;
}
