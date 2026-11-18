// AI on this Mac (onboarding spec S9; native contract N6): what Ozzie found (Ollama or LM Studio, and this Mac's
// memory), and "Check that it answers", which must pass before Ozzie uses a model (never "In use" before). Once Ollama
// is running, Ozzie offers the three models that suit Macs (small, medium, large), downloads the chosen one through
// Ollama with a real progress bar and a Stop, sets it up with room for Ozzie's questions, and checks it (owner's request,
// 2026-11-18). A model the person already has in Ollama, and LM Studio, keep today's path: choose, check, and Ollama's
// Context length hint. Only loopback addresses are ever asked; nothing about the church leaves this Mac.
import { useCallback, useEffect, useRef, useState } from "react";
import { useDay } from "./day-words.js";
import { Icon } from "./icons.js";
import { AI, CHOICE, downloadSaid, ENDED_AWAY, endedAwaySaid, localSaid, MAC, refusedSaid, removedSaid } from "./ai-words.js";
import { Ok, Problem, Quiet, Screen, Sheet, Status, useAiPlace } from "./ai-parts.js";
import type { CatalogueModel, DownloadRefusal, LocalApp, LocalAppState, LocalCheck, LocalFound, ModelProgress } from "./onboarding-bridge.js";

/**
 * How many AI on this Mac screens are open. One that is open shows a download's ending itself; with none open, the app
 * says it on Today instead (review M-1: the download carries on natively after the screen is left).
 */
let screensOpen = 0;
export const thisMacShown = () => screensOpen > 0;

/** Today's one line for a download and set-up that ended while no AI on this Mac screen was open (review M-1). */
export function MacEndedLine({ progress, onOpen, onClose }: { progress: ModelProgress; onOpen: () => void; onClose: () => void }) {
  if (progress.end === null) return null;
  const said = endedAwaySaid(progress.end, progress.check?.verdict ?? null, progress.model);
  if (!said) return null;
  return <section className="banner mac-ended" role="status">
    <Icon name={said.ok ? "check" : "info"} small />
    <div className="stack-tight">
      <p>{said.text}</p>
      <div className="ai-actions">
        {!said.ok && <button type="button" className="btn btn-secondary btn-sm" onClick={onOpen}>{ENDED_AWAY.open}</button>}
        <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>{ENDED_AWAY.close}</button>
      </div>
    </div>
  </section>;
}

/** Which of the spec's sentences fits what Ozzie found: the first that matches, in the spec's order. */
export type MacFound =
  /**
   * Ollama answers and native offers its models: `catalogue`, the rows shown (`shown`); `own`, models the person already
   * has (Ollama's, else LM Studio's).
   */
  | { kind: "setup"; ollama: LocalAppState; catalogue: CatalogueModel[]; own: LocalAppState | null }
  | { kind: "models"; app: LocalAppState }
  | { kind: "ollama-closed" } | { kind: "lm-server-off" }
  | { kind: "ollama-no-models" } | { kind: "lm-no-models" } | { kind: "nothing" };
export function macFound(found: LocalFound): MacFound {
  const ollama = found.apps.find(a => a.app === "ollama"), lm = found.apps.find(a => a.app === "lm-studio");
  if (ollama?.running && found.catalogue.length) {
    // The catalogue's rows shown are its rows; the person's other models come under them, one Ozzie no longer offers too.
    const catalogue = found.catalogue.filter(shown);
    const theirs = { ...ollama, models: ollama.models.filter(m => !catalogue.some(c => c.id === m.id)) };
    const own = theirs.models.length ? theirs : lm?.running && lm.models.length ? lm : null;
    return { kind: "setup", ollama, catalogue, own };
  }
  if (ollama?.running && ollama.models.length) return { kind: "models", app: ollama };
  if (lm?.running && lm.models.length) return { kind: "models", app: lm };
  if (ollama?.installed && !ollama.running) return { kind: "ollama-closed" };
  if (lm?.installed && !lm.running) return { kind: "lm-server-off" };
  if (ollama?.running) return { kind: "ollama-no-models" };
  if (lm?.running) return { kind: "lm-no-models" };
  return { kind: "nothing" };
}

/** A row Ozzie may download and set up now: Ozzie offers it, it fits this Mac's memory, and its disk unless it is already here. */
const offered = (m: CatalogueModel) => m.offered && m.fits && m.disk !== "not-enough";
/** A row shown: one Ozzie offers, or one it no longer offers whose copy or download of Ozzie's is here, to remove it. */
const shown = (m: CatalogueModel) => m.offered || m.set_up || m.downloaded_by_ozzie;
/** A row that can be chosen: to download and set up, or (one no longer offered) to remove. */
const selectable = (m: CatalogueModel) => offered(m) || (!m.offered && shown(m));
/** The download's own steps, while Stop the download still means something. */
const downloading = (p: ModelProgress) => p.end === null && ["starting", "downloading", "verifying", "finishing"].includes(p.phase);

type Pick = { kind: "own"; app: LocalApp; id: string } | { kind: "catalogue"; id: string };

export function ThisMacScreen({ onBack, onModel, onDone, done, onKey, onNone }: { onBack: () => void; onModel: (configured: boolean) => void; onDone: () => void; done: string;
  /** The other two ways, where AI on this Mac needs more memory than this Mac has: a key from an AI company, and No AI for now. */
  onKey?: () => void; onNone?: () => void }) {
  const { bridge } = useAiPlace();
  const day = useDay();
  const [found, setFound] = useState<LocalFound | "failed" | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<LocalCheck | null>(null);
  const [problem, setProblem] = useState("");
  // The one download and set-up (native's, so it outlives this screen) and why one couldn't start.
  const [job, setJob] = useState<ModelProgress | null>(null);
  const [refused, setRefused] = useState<DownloadRefusal | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState<{ text: string; ok: boolean } | null>(null);
  const live = useRef(true);
  // The latest onModel, so the native event is listened to once for this screen, not again on every render above it.
  const onModelRef = useRef(onModel);
  onModelRef.current = onModel;
  const wait = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A look after one that found nothing, which found nothing again: when, so Look again visibly did something (0.3.0 live).
  const shownNothing = useRef(false);
  const [lookedAt, setLookedAt] = useState<number | null>(null);
  const [, setClock] = useState(0);
  useEffect(() => {
    if (lookedAt === null) return;
    const t = setTimeout(() => setClock(c => c + 1), 60_000);
    return () => clearTimeout(t);
  }, [lookedAt]);
  /** The row to begin with, or the one already chosen while it is still there and offered. */
  const choose = useCallback((f: LocalFound) => {
    const w = macFound(f);
    if (w.kind === "setup") {
      const suits = w.catalogue.find(m => m.recommended && offered(m));
      setPick(p => p?.kind === "catalogue" && w.catalogue.some(m => m.id === p.id && selectable(m)) ? p
        : p?.kind === "own" && w.own?.app === p.app && w.own.models.some(m => m.id === p.id && m.fits) ? p
        : suits ? { kind: "catalogue", id: suits.id } : null);
      return;
    }
    if (w.kind !== "models") return;
    // The row native marks for this Mac is chosen to begin with when it fits (review M6): it costs nothing, and the
    // check still has to pass. A row already chosen and still listed stays chosen.
    const fits = (id: string) => w.app.models.some(m => m.id === id && m.fits);
    const suits = w.app.models.find(m => m.recommended && m.fits);
    setPick(p => p?.kind === "own" && p.app === w.app.app && fits(p.id) ? p : suits ? { kind: "own", app: w.app.app, id: suits.id } : null);
  }, []);
  const look = useCallback(() => {
    const again = shownNothing.current;
    setFound(null); setProblem(""); setLookedAt(null);
    bridge.findLocal().then(f => {
      if (!live.current) return;
      setFound(f);
      shownNothing.current = macFound(f).kind === "nothing";
      if (again && shownNothing.current) setLookedAt(Date.now());
      choose(f);
    }, () => { if (live.current) { shownNothing.current = false; setFound("failed"); } });
  }, [bridge, choose]);
  /** After a download or a removal: the rows again, without clearing the screen. */
  const refresh = useCallback(() => {
    bridge.findLocal().then(f => { if (live.current) { setFound(f); choose(f); } }, () => undefined);
  }, [bridge, choose]);
  useEffect(() => {
    live.current = true;
    look();
    return () => { live.current = false; if (wait.current) clearTimeout(wait.current); };
  }, [look]);
  useEffect(() => { screensOpen++; return () => { screensOpen--; }; }, []);
  // The download under way, or how the last one ended, even after this window was closed and opened again.
  useEffect(() => {
    const seen = (p: ModelProgress, opening = false) => {
      if (!live.current) return;
      setJob(p);
      // The one under way is the row chosen; on opening, so is one that ended without an answer, so its ending shows
      // (Today's "Open AI on this Mac", review M-1).
      if (p.end === null || (opening && !(p.end === "done" && p.check?.verdict === "answers"))) setPick({ kind: "catalogue", id: p.model });
    };
    void bridge.modelProgress().then(p => { if (p) seen(p, true); });
    const stop = bridge.onModelProgress(p => {
      seen(p);
      if (p.end === null) return;
      // Native saved the route when it answered; the app reads the AI in use again (as after a check, review L5).
      if (p.check?.verdict === "answers") onModelRef.current(true);
      refresh();
    });
    return stop;
  }, [bridge, refresh]);

  // "Open Ollama": open it, then look again after 5 seconds, when its server has started.
  const openApp = (app: LocalApp) => {
    setProblem("");
    bridge.openLocal(app).then(() => { wait.current = setTimeout(look, 5000); }, () => { if (live.current) setProblem(MAC.openFailed(app)); });
  };
  const runCheck = () => {
    if (pick?.kind !== "own") return;
    setChecking(true); setCheck(null);
    void bridge.checkLocal(pick.app, pick.id).then(r => {
      // Native saved the route when it answered, also after this screen was let go of (Change pressed during the check):
      // the app reads the AI in use again either way (review L5). Another choice made meanwhile wins: native then saves
      // nothing and answers "choice-changed" (review M-2).
      if (r.verdict === "answers") onModel(true);
      if (!live.current) return;
      setChecking(false); setCheck(r);
    });
  };
  const runDownload = () => {
    if (pick?.kind !== "catalogue") return;
    setRefused(null); setRemoved(null); setJob(null);
    void bridge.downloadModel(pick.id).then(r => {
      if (!live.current) return;
      if ("refused" in r) setRefused(r.refused);
      else setJob(j => j && j.model === r.progress.model && j.end === null ? j : r.progress);
    });
  };
  const remove = (id: string) => {
    setRemoving(false); setRemoved(null);
    void bridge.removeModel(id).then(r => {
      if (r.routeCleared) onModel(false);
      if (!live.current) return;
      setRemoved(removedSaid(r.removed, id, r.routeCleared));
      setJob(null);
      refresh();
    });
  };

  const what = found && found !== "failed" ? macFound(found) : null;
  const working = job !== null && job.end === null;
  const row = what?.kind === "setup" && pick?.kind === "catalogue" ? what.catalogue.find(m => m.id === pick.id) ?? null : null;
  // How the last download and set-up ended, for the model chosen now.
  const ended = job && job.end !== null && pick?.kind === "catalogue" && job.model === pick.id ? job : null;
  const jobAnswered = ended?.end === "done" && ended.check?.verdict === "answers";
  const answered = check?.verdict === "answers" || jobAnswered;
  /** Native's own sentence for starting an app that is on this Mac but not answering (contract N6 `start_hint`). */
  const hint = (app: LocalApp) => found && found !== "failed" ? found.apps.find(a => a.app === app)?.start_hint ?? null : null;
  const said = check && pick?.kind === "own" ? localSaid(check.verdict, pick.app, pick.id, day.day, check.seconds, check.small_room === true) : null;
  // A model Ozzie set up carries its own room, so the advice about Ollama's Context length never applies to it.
  const jobSaid = ended?.end === "done" && ended.check ? localSaid(ended.check.verdict, "ollama", ended.model, day.day, ended.check.seconds, false) : null;
  const lookButton = (primary: boolean) => <button type="button" className={`btn ${primary ? "btn-primary ai-primary" : "btn-secondary"}`} onClick={look}>{MAC.lookAgain}</button>;
  const memory = found !== "failed" && found?.advice && found.memory_gb !== null ? MAC.memory(found.advice, found.memory_gb) : null;
  // No model Ozzie offers fits this Mac's memory: said plainly once, with the other two ways; a model of the person's own
  // stays theirs to check, and one Ozzie no longer offers stays theirs to remove.
  const tooSmall = found !== "failed" && found?.advice === "too-small";
  /** Today's rows of a person's own models, chosen for "Check that it answers". */
  const ownRows = (app: LocalAppState) => <ul className="ai-rows">{app.models.map(m => {
    const chosen = pick?.kind === "own" && pick.app === app.app && pick.id === m.id;
    return <li key={m.id}><button type="button" className="ai-row" aria-pressed={chosen} disabled={!m.fits || checking || working}
      onClick={() => { setPick({ kind: "own", app: app.app, id: m.id }); setCheck(null); }}>
      <span>{MAC.row(m.id, m.bytes)}</span>
      {m.recommended && m.fits && <span className="ai-tag">{MAC.recommended}</span>}
      {!m.fits && <span className="ai-tag ai-tag-muted">{MAC.tooBig}</span>}
    </button></li>;
  })}</ul>;
  // With the three shown, one primary: for the row chosen (a model already set up is checked again through the same
  // steps, which skip what is done), or for the person's own model when one of those is chosen.
  const primary = answered ? <button type="button" className="btn btn-primary ai-primary" onClick={onDone}>{done}</button>
    : what?.kind === "setup" && pick?.kind !== "own" ? (tooSmall || row?.offered === false ? null
      : <button type="button" className="btn btn-primary ai-primary" disabled={working || !row || !offered(row)} onClick={runDownload}>
        {row?.set_up ? MAC.check : row?.downloaded ? MAC.setUp : MAC.download}</button>)
    : what?.kind === "models" || what?.kind === "setup" ? <button type="button" className="btn btn-primary ai-primary" disabled={pick?.kind !== "own" || checking || working} onClick={runCheck}>{MAC.check}</button>
    : what?.kind === "ollama-no-models" || what?.kind === "lm-no-models" || found === "failed" ? lookButton(true)
    : what?.kind === "ollama-closed" ? lookButton(false) : null;
  return <Screen title={MAC.title}>
    <Status text={found === null ? MAC.looking : lookedAt !== null
      ? MAC.looked(Date.now() - lookedAt < 60_000 ? null : new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(lookedAt)) : ""} />
    {found === "failed" && <Problem text={MAC.lookFailed} />}
    {tooSmall && <div className="ai-head">
      {memory && <p className="ai-body">{memory}</p>}
      <p className="ai-body">{MAC.tooSmallWays}</p>
      {(onKey || onNone) && <div className="ai-actions">
        {onKey && <button type="button" className="btn btn-secondary" onClick={onKey}>{MAC.useKey}</button>}
        {onNone && <button type="button" className="btn btn-secondary" onClick={onNone}>{CHOICE.none}</button>}
      </div>}
    </div>}
    {what?.kind === "setup" && <>
      {/* Too small with no models: the 16 GB line above says what matters, never "no AI models yet" over nothing (review L-7). */}
      {(what.ollama.models.length > 0 || !tooSmall) && <p className="ai-body">{what.ollama.models.length ? MAC.found("ollama", what.ollama.models.length) : MAC.ollamaNoModels}</p>}
      {memory && !tooSmall && <p className="ai-body">{memory}</p>}
      {!tooSmall && <p className="ai-body">{MAC.setupLede}</p>}
      {/* Too small: only a model of Ozzie's it no longer offers is shown, to remove it; every other row would be too big. */}
      <ul className="ai-rows">{what.catalogue.filter(m => !tooSmall || !m.offered).map(m => {
        const chosen = pick?.kind === "catalogue" && pick.id === m.id;
        return <li key={m.id}><button type="button" className="ai-row" aria-pressed={chosen} disabled={!selectable(m) || checking || working}
          onClick={() => { setPick({ kind: "catalogue", id: m.id }); setCheck(null); setRefused(null); setRemoved(null); }}>
          <span>{MAC.catalogueRow(m.size, m.bytes)}</span>
          {m.recommended && m.offered && m.fits && <span className="ai-tag">{MAC.recommended}</span>}
          {m.downloaded && <span className="ai-tag ai-tag-muted">{MAC.onThisMac}</span>}
          {!m.offered && <span className="ai-tag ai-tag-muted">{MAC.notOffered}</span>}
          {m.offered && !m.fits && <span className="ai-tag ai-tag-muted">{MAC.tooBig}</span>}
          {m.offered && m.fits && m.disk === "not-enough" && <span className="ai-tag ai-tag-muted">{MAC.needsSpace}</span>}
        </button></li>;
      })}</ul>
      {found !== "failed" && found?.free_bytes != null && what.catalogue.some(m => m.offered && m.fits && m.disk === "not-enough") && <p className="ai-small">{MAC.space(found.free_bytes)}</p>}
      {row && !working && !ended && !removed && <p className="ai-body">{!row.offered ? MAC.notOfferedLine(row.id)
        : row.downloaded ? MAC.willSetUp(row.id) : MAC.willDownload(row.id, row.bytes)}</p>}
      {working && job && <div className="ai-download">
        <Status text={MAC.step(job.phase, job.model)} />
        {downloading(job) && <>
          <progress className="ai-progress" max={Math.max(job.total_bytes, 1)} value={job.done_bytes} aria-label={MAC.progressLabel(job.model)} />
          <p className="ai-small">{MAC.amount(job.done_bytes, job.total_bytes)}</p>
          <p className="ai-small">{MAC.keepsGoing}</p>
        </>}
      </div>}
      {refused && <Problem text={refusedSaid(refused)} />}
      {ended && ended.end !== "done" && <Problem text={downloadSaid(ended.end!, ended.model, ended.phase === "setting-up")} calm={ended.end === "cancelled"} />}
      {jobSaid && (jobAnswered ? <Ok lines={jobSaid.lines} /> : <Problem text={jobSaid.lines[0]!} />)}
      {removed && (removed.ok ? <Ok lines={[removed.text]} /> : <Problem text={removed.text} />)}
      {row && !working && (row.set_up || row.downloaded_by_ozzie) && <Quiet onClick={() => setRemoving(true)}>{MAC.remove}</Quiet>}
      {what.own && <>
        <p className="ai-body ai-sub">{MAC.yourModels}</p>
        {ownRows(what.own)}
        {pick?.kind === "own" && !answered && what.own.app === "ollama" && <p className="ai-body">{MAC.ollamaRoom}</p>}
      </>}
    </>}
    {what?.kind === "models" && <>
      <p className="ai-body">{MAC.found(what.app.app, what.app.models.length)}</p>
      {memory && !tooSmall && <p className="ai-body">{memory}</p>}
      {ownRows(what.app)}
      {!answered && what.app.app === "ollama" && <p className="ai-body">{MAC.ollamaRoom}</p>}
      {!answered && <p className="ai-body">{MAC.pickHint}</p>}
    </>}
    {what?.kind === "ollama-closed" && <Problem text={[MAC.ollamaClosed, hint("ollama")].filter(Boolean).join(" ")} calm>
      <button type="button" className="btn btn-primary ai-primary" onClick={() => openApp("ollama")}>{MAC.openApp("ollama")}</button>
    </Problem>}
    {what?.kind === "lm-server-off" && <Problem text={hint("lm-studio") ? `${MAC.lmOn} ${hint("lm-studio")}` : MAC.lmServerOff} calm>
      <button type="button" className="btn btn-secondary" onClick={() => openApp("lm-studio")}>{MAC.openApp("lm-studio")}</button>
      {lookButton(true)}
    </Problem>}
    {what?.kind === "ollama-no-models" && <>
      <p className="ai-body">{MAC.ollamaNoModels}</p>
      {!tooSmall && <p className="ai-body">{MAC.getModel(found !== "failed" ? found?.recommended_bytes ?? null : null)}</p>}
    </>}
    {what?.kind === "lm-no-models" && <p className="ai-body">{MAC.lmNoModels}</p>}
    {what?.kind === "nothing" && tooSmall && <>
      <p className="ai-body">{MAC.nothing}</p>
      <p className="ai-body">{MAC.ownStill}</p>
      <div className="ai-actions">{lookButton(false)}</div>
    </>}
    {what?.kind === "nothing" && !tooSmall && <>
      <p className="ai-body">{MAC.nothing}</p>
      <ol className="ai-steps">
        <li><div><p>{MAC.guide[0].text}</p>
          <button type="button" className="btn btn-secondary" onClick={() => { bridge.openHelpPage("ollama-download").catch(() => { if (live.current) setProblem(AI.browserFailed); }); }}>{MAC.guide[0].button}</button></div></li>
        <li><div><p>{MAC.guide[1].text}</p>
          <button type="button" className="btn btn-primary ai-primary" onClick={look}>{MAC.guide[1].button}</button></div></li>
        <li><div><p>{MAC.getModel(found !== "failed" ? found?.recommended_bytes ?? null : null)}</p>
          {lookButton(false)}</div></li>
      </ol>
    </>}
    {problem && <Problem text={problem} calm />}
    <Status text={checking && pick?.kind === "own" ? MAC.checking(pick.id) : ""} />
    {said && (check?.verdict === "answers" ? <Ok lines={said.lines} /> : <Problem text={said.lines[0]!} />)}
    {/* It answered, but the app gave the model too little room for a longer question: one plain line on the fix (B-2). */}
    {check?.verdict === "answers" && said?.advice && <p className="ai-body">{said.advice}</p>}
    <p className="ai-small">{MAC.honest}</p>
    <div className="ai-actions">
      {primary}
      {working && job && downloading(job) && <button type="button" className="btn btn-secondary" onClick={() => { void bridge.stopDownload(); }}>{MAC.stop}</button>}
      {!answered && <Quiet onClick={onBack}>{AI.back}</Quiet>}
    </div>
    {removing && row && <Sheet title={MAC.removeTitle(row.id)} onClose={() => setRemoving(false)}>
      <p className="ai-body">{MAC.removeBody(row.id, row.downloaded_by_ozzie, row.bytes)}</p>
      <div className="ai-actions">
        <button type="button" className="btn btn-primary ai-primary" onClick={() => setRemoving(false)}>{MAC.removeKeep}</button>
        <button type="button" className="btn btn-forget" onClick={() => remove(row.id)}>{MAC.removeYes}</button>
      </div>
    </Sheet>}
  </Screen>;
}
