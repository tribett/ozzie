// Settings' AI section (onboarding spec §3, §4.4, S10d). It shows which AI Ozzie uses and what that route needs now,
// and "Change" opens the very same screens as first run (ai-choice.tsx), so the two can't differ. The church's own key:
// this month's count and its limit ("Change the limit"), and "Remove my key from this Mac" (also once AI is off, while a key is kept). AI on this Mac: whether it has answered the
// check, and with LM Studio that its LM Link can answer from another computer. Ozzie's AI: its state and how to stop
// paying, and, while another way is in use and this Mac still holds its connection, how to disconnect it. Every word
// comes from closed codes; native's label, a key or anything a company wrote is never shown.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useDay } from "./day-words.js";
import { Icon } from "./icons.js";
import { AI, aiLine, CHOICE, LIMIT, localModel, MAC, monthDay, OLLAMA, OZZIE } from "./ai-words.js";
import { AiPlaceContext, Ok, Problem, Quiet, Sheet, SentSheet, Status, type AiPlace } from "./ai-parts.js";
import { AiFlow, type AiStep } from "./ai-choice.js";
import { AiLine } from "./ai-line.js";
import { accountOk, holdsOzzie, OzzieAiState } from "./ai-ozzie.js";
import { managedProblem, model, noPlan, type ModelStatus } from "./model.js";
import { COMPANIES, onboarding, type KeyProvider } from "./onboarding-bridge.js";

const ownProvider = (s: ModelStatus): KeyProvider => s.provider && (COMPANIES as readonly string[]).includes(s.provider) ? s.provider : "other";
const when = (ms: number) => new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

/**
 * AI in Settings. `preview` is accepted and ignored: first run no longer shows a preview of this section (it shows
 * AiChoice), and the prop stays only until setup-flow.tsx stops passing it.
 */
export function AiSettings({ onChange, onAnswer, labelledBy, onCheckSetup }: {
  onChange: (configured: boolean) => void; labelledBy?: string; onCheckSetup?: () => void; preview?: boolean;
  /**
   * A way chosen, or No AI for now, on the screens shown here: an answer, so Today's Finish setting up stops asking, as
   * it does when the same screens open over a page (walk-through, 2026-11-18). Not now ("Back") isn't one.
   */
  onAnswer?: ((how: "chosen" | "none") => void) | undefined;
}) {
  const bridge = onboarding;
  const day = useDay();
  const limitId = useId();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [loaded, setLoaded] = useState<"loading" | "ok" | "failed">("loading");
  const [step, setStep] = useState<AiStep | null>(null);
  const [removing, setRemoving] = useState(false);
  const [sent, setSent] = useState(false);
  const [limit, setLimit] = useState<string | null>(null);
  const [limitProblem, setLimitProblem] = useState("");
  const [note, setNote] = useState("");
  // "No AI for now" left the church's key (or keys) on this Mac: said with the count as it is when shown, so the
  // sentence agrees with the removal link beside it (live, 2026-11-18).
  const [keyStays, setKeyStays] = useState(false);
  const [planLink, setPlanLink] = useState(false);
  const [problem, setProblem] = useState("");
  // A removal in this visit that left no key ("removed" or "none"): only then is "Remove my key from this Mac" no longer
  // offered with no AI chosen. Ozzie's own list of keys (`saved`) can't decide it: removing also deletes keys that list
  // can't name (one added by hand, one saved the old way, one whose entry couldn't be written; review M3). A key in use
  // again brings it back.
  const [keyGone, setKeyGone] = useState(false);
  // The parent's callback may be new on every render; reading it through a ref keeps the status read to once per need.
  const changed = useRef(onChange);
  changed.current = onChange;
  const shown = useCallback((s: ModelStatus) => { setStatus(s); setLoaded("ok"); changed.current(s.configured); if (s.route === "own") setKeyGone(false); }, []);
  const refresh = useCallback(() => { model.status().then(shown, () => setLoaded(l => l === "ok" ? l : "failed")); }, [shown]);
  useEffect(() => { refresh(); }, [refresh]);
  // Which companies' keys are kept on this Mac (native `own_key_saved`), read again with each status: removing takes
  // every one, so the words name them all. For the words only. null: native couldn't say.
  const [saved, setSaved] = useState<KeyProvider[] | null>(null);
  // How many keys removing would take now (native `own_key_count`, from the Keychain's list alone, the very keys
  // `remove_own_key` deletes; review L-4): none hides the removal while no AI is chosen. null: native couldn't count.
  const [kept, setKept] = useState<number | null>(null);
  useEffect(() => {
    if (!status) return;
    let live = true;
    void bridge.savedKeys().then(next => { if (live) setSaved(known => next ?? known); });
    void bridge.keptKeys().then(next => { if (live) setKept(next); });
    return () => { live = false; };
  }, [bridge, status]);
  const many = (saved?.length ?? 0) > 1 || (kept ?? 0) > 1;
  // When Ozzie installed the Ollama that is in Applications now (native `ollama_install_history`): said, with how to remove
  // it, whichever way AI is used. Ozzie doesn't remove another company's app itself. null: it didn't, or native can't say.
  const [ollamaAt, setOllamaAt] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.ollamaHistory().then(h => { if (live) setOllamaAt(h?.installed_at_ms ?? null); });
    return () => { live = false; };
  }, [bridge, step]);
  const place: AiPlace = { bridge, mode: "settings", onCheckSetup, focus: false };

  if (step) return <div className="ai-settings" role="group" aria-labelledby={labelledBy}>
    <AiFlow mode="settings" bridge={bridge} start={step} onCheckSetup={onCheckSetup} onModel={c => changed.current(c)} onDone={how => {
      const before = status;
      setStep(null);
      if (how !== "later") onAnswer?.(how);
      // A key from another company now works: the earlier one stays on this Mac until removed (contract item 10).
      model.status().then(s => {
        shown(s);
        if (how === "chosen" && before?.route === "own" && s.route === "own" && ownProvider(before) !== ownProvider(s)) setNote(LIMIT.earlierKey(ownProvider(before)));
      }, () => setLoaded(l => l === "ok" ? l : "failed"));
      // No AI for now (native `set_no_ai`): nothing is removed, so it says what stays and how to remove or stop it.
      if (how === "none" && before?.route === "own") { setNote(""); setKeyStays(true); }
      else if (how === "none" && before?.route === "local") setNote(LIMIT.noneLocal);
      else if (how === "none" && before?.route === "managed") { setNote(LIMIT.noneOzzie); setPlanLink(true); }
    }} />
  </div>;

  const open = (s: AiStep) => { setNote(""); setKeyStays(false); setPlanLink(false); setProblem(""); setStep(s); };
  const route = loaded === "ok" ? status?.route ?? "none" : null;
  const provider = status && route === "own" ? ownProvider(status) : "other";
  // The line's "Check" goes straight to what the trouble needs.
  const fix = () => {
    const trouble = aiLine(status).trouble;
    if (!status || !trouble) return open({ at: "choose" });
    if (status.route === "own") return status.setup === "month-limit" ? setLimit(String(status.month?.limit ?? 1000)) : open({ at: "key", provider });
    if (status.route === "local") return open({ at: "mac" });
    return open({ at: "ozzie", reconnect: status.managed === "reconnect" || status.setup === "reconnect" });
  };
  const saveLimit = () => {
    const n = Number((limit ?? "").replace(/[,\s]/gu, ""));
    if (!Number.isInteger(n) || n < 100 || n > 20_000) { setLimitProblem(LIMIT.invalid); return; }
    setLimitProblem("");
    bridge.setMonthLimit(n).then(s => { shown(s); setLimit(null); }, () => setLimitProblem(LIMIT.failed));
  };
  // "Remove my key from this Mac" (native `remove_own_key`): every key of the church's own, whatever route is chosen.
  const remove = () => {
    setRemoving(false); setProblem(""); setNote(""); setKeyStays(false); setPlanLink(false);
    bridge.removeOwnKey().then(({ removed, status: after }) => {
      if (after) shown(after); else refresh();
      if (removed !== "refused") { setSaved([]); setKeyGone(true); }
      if (removed === "removed") setNote(many ? LIMIT.removedMany : LIMIT.removed);
      else if (removed === "none") setNote(LIMIT.removeNone);
      else setProblem(LIMIT.removeRefused);
    }, () => setProblem(LIMIT.removeFailed));
  };
  const seePlan = () => { setProblem(""); bridge.openHelpPage("ozzie-account").catch(() => setProblem(OZZIE.browserFailed("ozzie.church/account"))); };
  // Another way (or none) in use while this Mac still holds its connection to Ozzie's AI: choosing another way never ends
  // it, so its own way to end it is here too (native `managed_disconnect`: revoked on ozzie.church, then forgotten here).
  // Disconnecting never stops the payments, so with a plan on the account it says so, with See my plan (review M2).
  const heldOzzie = route !== null && route !== "managed" && status?.managed === "connected";
  const disconnectHeld = () => {
    const paying = accountOk(status?.account) && !noPlan(status.account);
    setProblem(""); setNote(""); setKeyStays(false); setPlanLink(false);
    model.disconnect().then(s => { shown(s); setNote(paying ? OZZIE.disconnectedPlan : OZZIE.disconnected); setPlanLink(paying); }, e => setProblem(managedProblem(e)));
  };
  const resets = status ? monthDay(status) : null;
  return <AiPlaceContext.Provider value={place}><div className="ai ai-now ai-settings" role="group" aria-labelledby={labelledBy}>
    {loaded === "loading" && <Status text={AI.loading} />}
    {loaded === "failed" && <Problem text={AI.statusFailed} />}
    {loaded === "ok" && <AiLine status={status} onChange={fix} />}
    {route === "none" && <>
      <p className="ai-body">{CHOICE.bodySettings(day.day)}</p>
      {/* A key may stay on this Mac after No AI for now: it can be removed from here too, while one is kept. */}
      {!keyGone && kept !== 0 && <div className="ai-actions"><Quiet onClick={() => setRemoving(true)}>{many ? LIMIT.removeMany : LIMIT.remove}</Quiet></div>}
    </>}
    {route === "own" && status && <>
      {status.setup === "ready" && status.month && <p className="ai-body">{LIMIT.used(status.month.used, status.month.limit, resets)}</p>}
      {status.setup === "month-limit" && <Problem text={LIMIT.paused(resets)}>
        <button type="button" className="btn btn-primary" onClick={() => setLimit(String(status.month?.limit ?? 1000))}>{LIMIT.change}</button>
      </Problem>}
      {(status.setup === "no-key" || status.setup === "own-key-not-bound") && <Problem text={status.setup === "no-key" ? LIMIT.noKey(provider) : LIMIT.oldKey}>
        <button type="button" className="btn btn-primary" onClick={() => open({ at: "key", provider })}>{LIMIT.addKey}</button>
      </Problem>}
      {limit !== null ? <div className="ai-fields">
        <div className="field">
          <label htmlFor={limitId}>{LIMIT.label}</label>
          <input id={limitId} className="input" inputMode="numeric" autoComplete="off" value={limit} aria-describedby={`${limitId}-help`} onChange={e => setLimit(e.target.value)} />
          <p id={`${limitId}-help`} className="ai-small">{LIMIT.help}</p>
        </div>
        {limitProblem && <p className="problem" role="alert">{limitProblem}</p>}
        <div className="ai-actions">
          <button type="button" className="btn btn-primary ai-primary" onClick={saveLimit}>{LIMIT.save}</button>
          <Quiet onClick={() => { setLimit(null); setLimitProblem(""); }}>{LIMIT.keep}</Quiet>
        </div>
      </div> : <div className="ai-actions">
        {status.setup !== "month-limit" && status.month && <Quiet onClick={() => setLimit(String(status.month!.limit))}>{LIMIT.change}</Quiet>}
        <button type="button" className="btn btn-secondary" onClick={() => setRemoving(true)}>{many ? LIMIT.removeMany : LIMIT.remove}</button>
      </div>}
      <details className="ai-more"><summary><Icon name="chev" small />{AI.howTitle}</summary><p className="ai-small">{AI.how}</p></details>
    </>}
    {route === "local" && status?.not_offered && <p className="ai-body">{MAC.notOfferedInUse(localModel(status.label))}</p>}
    {route === "local" && status?.setup === "not-on-this-mac" && <Problem text={LIMIT.localElsewhere(localModel(status.label), status.local_app ?? null)}>
      <button type="button" className="btn btn-primary" onClick={() => open({ at: "mac" })}>{LIMIT.chooseLocal}</button>
    </Problem>}
    {route === "local" && status && status.setup !== "not-on-this-mac" && (status.setup === "not-checked" || !status.configured
      ? <Problem text={LIMIT.localNotChecked} calm><button type="button" className="btn btn-primary" onClick={() => open({ at: "mac" })}>{LIMIT.checkLocal}</button></Problem>
      : typeof status.checked_at_ms === "number" && Number.isFinite(status.checked_at_ms) ? <Ok lines={[LIMIT.localChecked(when(status.checked_at_ms), status.local_app ?? null)]} /> : null)}
    {/* LM Studio can run its models on another of the person's computers (LM Link), which Ozzie can't see: said plainly. */}
    {route === "local" && status?.local_app === "lm-studio" && status.setup !== "not-on-this-mac" && <p className="ai-body">{MAC.lmLink}</p>}
    {route === "managed" && status && <OzzieAiState status={status} onStart={() => open({ at: "ozzie" })} onReconnect={() => open({ at: "ozzie", reconnect: true })}
      onAnother={() => open({ at: "choose" })} onChanged={shown} />}
    {heldOzzie && <>
      {/* "Use it again" only where using it again is offered: never to an account known to have no plan (review L4). */}
      {holdsOzzie(status) && <p className="ai-small">{OZZIE.heldSettings}</p>}
      <div className="ai-actions"><Quiet onClick={disconnectHeld}>{OZZIE.disconnectHeld}</Quiet></div>
    </>}
    {problem && <Problem text={problem} />}
    {loaded === "ok" && ollamaAt !== null && <details className="ai-more"><summary><Icon name="chev" small />{OLLAMA.settingsTitle}</summary>
      <p className="ai-small">{OLLAMA.settingsBody(new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date(ollamaAt)))}</p>
      <p className="ai-small">{OLLAMA.settingsLogin}</p>
      <p className="ai-small">{OLLAMA.settingsRemove}</p>
    </details>}
    <Status text={keyStays ? LIMIT.noneOwn(many) : note} />
    {planLink && <div className="ai-actions"><button type="button" className="btn btn-secondary" onClick={seePlan}>{OZZIE.seePlan}</button></div>}
    {loaded !== "loading" && <div className="ai-head">
      <p className="ai-small">{AI.namesLine}</p>
      <Quiet onClick={() => setSent(true)}>{AI.seeSent}</Quiet>
    </div>}
    {sent && <SentSheet onClose={() => setSent(false)} />}
    {removing && <Sheet title={many ? LIMIT.removeTitleMany : LIMIT.removeTitle} onClose={() => setRemoving(false)}>
      <p className="ai-body">{many && saved ? LIMIT.removeBodyMany(saved, route === "own") : LIMIT.removeBody(provider, route === "own")}</p>
      <div className="ai-actions">
        <button type="button" className="btn btn-primary ai-primary" onClick={() => setRemoving(false)}>{many ? LIMIT.removeKeepMany : LIMIT.removeKeep}</button>
        <button type="button" className="btn btn-forget" onClick={remove}>{many ? LIMIT.removeYesMany : LIMIT.removeYes}</button>
      </div>
    </Sheet>}
  </div></AiPlaceContext.Provider>;
}
