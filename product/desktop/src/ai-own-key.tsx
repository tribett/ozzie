// Your church's own AI (onboarding spec S7) and a key from an AI company (S8a–S8c; native contract N5). The key is never
// in this page: "Paste my key" asks native, which takes it in its own window (or, until that window is built, from the
// clipboard), checks it with one fixed request, keeps it in the Keychain only if it works, and answers with a closed
// verdict. This page shows the verdict's own sentence and nothing a company wrote.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.js";
import { useDay } from "./day-words.js";
import { AI, COMPANIES, COMPANY as COMPANY_WORDS, KEY, keySaid, OWN, type KeyStep } from "./ai-words.js";
import { InUseTag, Ok, Problem, Quiet, Screen, SentSheet, Status, useAiPlace, type InUse } from "./ai-parts.js";
import { COMPANIES as COMPANY_IDS, type Company, type KeyProvider, type KeyResult, type KeyTarget, type Provider } from "./onboarding-bridge.js";

/** S7: a key from an AI company, or AI on this Mac. */
/** S7. `inUse`: the way Ozzie uses AI now, when it is one of these two, is marked "In use now". */
export function OwnScreen({ inUse = null, onKey, onMac, onBack }: { inUse?: InUse; onKey: () => void; onMac: () => void; onBack: () => void }) {
  return <Screen title={OWN.title}>
    <ul className="ai-cards">
      <li><button type="button" className="ai-card" onClick={onKey}><span className="ai-card-t">{OWN.key}{inUse === "own" && <InUseTag />}</span><span className="ai-card-d">{OWN.keyCost}</span></button></li>
      <li><button type="button" className="ai-card" onClick={onMac}><span className="ai-card-t">{OWN.mac}{inUse === "local" && <InUseTag />}</span><span className="ai-card-d">{OWN.macCost}</span></button></li>
    </ul>
    <div className="ai-actions"><Quiet onClick={onBack}>{AI.back}</Quiet></div>
  </Screen>;
}

/** The companies' fixed data (providers.json through native), by id; null until it arrives, empty if native can't say. */
function useProviders(): Partial<Record<Company, Provider>> | null {
  const { bridge } = useAiPlace();
  const [byId, setById] = useState<Partial<Record<Company, Provider>> | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.providers().then(list => { if (live) setById(Object.fromEntries(list.map(p => [p.id, p]))); });
    return () => { live = false; };
  }, [bridge]);
  return byId;
}

/**
 * The companies a key of the church's own is kept for on this Mac (native `own_key_saved`: Ozzie's own list of hosts;
 * no key is read, and none ever reaches this page). Empty until native says, or when it can't.
 */
function useKeptFor(): readonly KeyProvider[] {
  const { bridge } = useAiPlace();
  const [kept, setKept] = useState<readonly KeyProvider[]>([]);
  useEffect(() => {
    let live = true;
    void bridge.savedKeys().then(list => { if (live && list) setKept(list); });
    return () => { live = false; };
  }, [bridge]);
  return kept;
}

/**
 * S8a: the companies in the spec's order, with "Another AI company" under More choices. Nothing is chosen to begin with.
 * A company is shown only once this release's live test passed for it (decision 19, native's `verified_live`); while
 * none has, the screen says so and points to AI on this Mac.
 */
export function CompaniesScreen({ onPick, onMac, onBack }: { onPick: (p: KeyProvider) => void; onMac: () => void; onBack: () => void }) {
  const providers = useProviders();
  const keptFor = useKeptFor();
  const checked = providers ? COMPANY_IDS.filter(c => providers[c]?.verified === true) : [];
  return <Screen title={COMPANIES.title}>
    {providers && (checked.length ? <>
      <p className="ai-body">{COMPANIES.body}</p>
      <ul className="ai-cards">{checked.map(c => <li key={c}>
        <button type="button" className="ai-card" onClick={() => onPick(c)}>
          <span className="ai-card-t">{COMPANIES.card(c)}{providers[c]?.easiest && <span className="ai-tag">{COMPANIES.easiest}</span>}
            {keptFor.includes(c) && <span className="ai-tag ai-tag-muted">{COMPANIES.kept}</span>}</span>
          <span className="ai-card-d">{COMPANIES.cost(c, providers[c] ?? null)}</span>
        </button>
      </li>)}</ul>
    </> : <>
      <p className="ai-body">{COMPANIES.noneChecked}</p>
      <div className="ai-actions"><button type="button" className="btn btn-secondary" onClick={onMac}>{COMPANIES.useMac}</button></div>
    </>)}
    <details className="ai-more">
      <summary><Icon name="chev" small />{COMPANIES.more}</summary>
      <ul className="ai-cards"><li><button type="button" className="ai-card" onClick={() => onPick("other")}>
        <span className="ai-card-t">{COMPANIES.other}</span><span className="ai-card-d">{COMPANIES.otherCost}</span></button></li></ul>
    </details>
    {checked.length > 0 && <p className="ai-small">{COMPANIES.subscription}</p>}
    <div className="ai-actions"><Quiet onClick={onBack}>{AI.back}</Quiet></div>
  </Screen>;
}

/** A simple drawing of the company's page for one step, its button circled (as S3's drawing of Planning Center's page). */
function StepDrawing({ step, company }: { step: KeyStep; company: string }) {
  const w = Math.min(260, 36 + step.drawn.length * 9);
  const x = 160 - w / 2;
  return <svg className="ai-draw" viewBox="0 0 320 150" role="img" aria-label={step.alt}>
    <rect x="1" y="1" width="318" height="148" rx="12" className="ai-draw-page" />
    <rect x="1" y="1" width="318" height="24" rx="12" className="ai-draw-bar" />
    <circle cx="18" cy="13" r="4" className="ai-draw-dot" /><circle cx="32" cy="13" r="4" className="ai-draw-dot" /><circle cx="46" cy="13" r="4" className="ai-draw-dot" />
    <text x="160" y="52" textAnchor="middle" className="ai-draw-h">{company}</text>
    <rect x="80" y="64" width="160" height="8" rx="4" className="ai-draw-lines" />
    <rect x={x} y="92" width={w} height="30" rx="8" className="ai-draw-btn" />
    <text x="160" y="112" textAnchor="middle" className="ai-draw-btn-t">{step.drawn}</text>
    <ellipse cx="160" cy="107" rx={w / 2 + 18} ry="24" className="ai-draw-ring" />
  </svg>;
}

/** An https address that isn't Planning Center's: the same rule native applies (`set_model_route`). */
const usableAddress = (v: string) => /^https:\/\/[^\s/]+\.[^\s/]+(?:\/\S*)?$/u.test(v) && !/planningcenteronline\.com/iu.test(v);

/**
 * S8b and S8c: the company's three steps, each opening its page; then "Paste my key", and what the check said. `done`
 * names the button after a working key (first run: the watched service's page; otherwise the page it goes back to).
 */
export function KeyScreen({ provider: first, onBack, onLater, onModel, onDone, done, onCompanies, onMac }: {
  provider: KeyProvider; onBack: () => void; onLater: () => void; onModel: (configured: boolean) => void; onDone: () => void; done: string;
  /** The company list, and AI on this Mac: the ways on when this company can't take the key (review F3). */
  onCompanies?: () => void; onMac?: () => void;
}) {
  const { bridge } = useAiPlace();
  const day = useDay();
  const providers = useProviders();
  const [provider, setProvider] = useState<KeyProvider>(first);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeyResult | null>(null);
  const [pageProblem, setPageProblem] = useState(false);
  const [other, setOther] = useState({ baseUrl: "", model: "" });
  const [addressProblem, setAddressProblem] = useState(false);
  const [sent, setSent] = useState(false);
  // This build has no native key window: the key comes from what was copied, and the screen says so from then on.
  const [viaClipboard, setViaClipboard] = useState(false);
  // A key for this company kept on this Mac leads the screen (live in the release app, 2026-11-18): `usedKept`, the last
  // check was of that key; `keptGone`, native found none kept any more.
  const keptFor = useKeptFor();
  const [usedKept, setUsedKept] = useState(false);
  const [keptGone, setKeptGone] = useState(false);
  const live = useRef(true);
  // The key native holds is dropped when this screen closes, whatever happened.
  useEffect(() => { live.current = true; return () => { live.current = false; void bridge.forgetKey(); }; }, [bridge]);

  const info = provider === "other" ? null : providers?.[provider] ?? null;
  const target = (p: KeyProvider): KeyTarget => p === "other" ? { provider: p, baseUrl: other.baseUrl, model: other.model } : { provider: p };
  const run = async (ask: () => Promise<KeyResult>) => {
    setBusy(true); setResult(null); setPageProblem(false);
    const r = await ask().catch((): KeyResult => ({ verdict: "unavailable" }));
    // A key that works is saved with its route, also after this screen was let go of: the AI in use is read again (L5).
    if (r.verdict === "works") onModel(true);
    if (!live.current) return;
    if (r.verdict === "no-kept-key") setKeptGone(true);
    setBusy(false); setResult(r);
  };
  /** "Use the key already on this Mac": native checks the key it kept, which never comes to this page. */
  const tryKept = (c: Company) => { setUsedKept(true); void run(() => bridge.useKeptKey(c)); };
  const paste = () => {
    if (provider === "other" && (!usableAddress(other.baseUrl) || !other.model)) { setAddressProblem(true); return; }
    setAddressProblem(false); setUsedKept(false);
    const t = target(provider);
    // The native window first; until it is built, the clipboard (contract N5).
    void run(async () => {
      const r = await bridge.enterKey(t);
      if (r.verdict !== "unavailable") return r;
      if (live.current) setViaClipboard(true);
      return bridge.pasteKey(t);
    });
  };
  const again = (p: KeyProvider = provider) => { setProvider(p); void run(() => bridge.checkKeyAgain(target(p))); };
  const open = (page: "sign-in" | "billing" | "keys" | "settings") => {
    if (provider === "other") return;
    setPageProblem(false);
    bridge.openHelpPage(`${provider}-${page}`).catch(() => { if (live.current) setPageProblem(true); });
  };

  const host = (() => { try { return provider === "other" && other.baseUrl ? new URL(other.baseUrl).host : null; } catch { return null; } })();
  const said = result ? keySaid(result.verdict, provider, result.looks_like, host, usedKept) : null;
  const works = result?.verdict === "works";
  const extra = said?.extra ?? null;
  const kept = provider !== "other" && keptFor.includes(provider) && !keptGone;
  /** What the check said, under the button that asked for it. */
  const outcome = <>
    <Status text={busy ? KEY.checking(provider) : ""} />
    {said && (works ? <Ok lines={[said.text]} /> : <Problem text={said.text}>
      {extra && "page" in extra && <button type="button" className="btn btn-secondary" onClick={() => open(extra.page)}>{extra.label}</button>}
      {extra && "useOther" in extra && <button type="button" className="btn btn-secondary" onClick={() => again(extra.useOther)}>{extra.label}</button>}
      {said.again && <button type="button" className="btn btn-secondary" onClick={() => again()}>{KEY.checkAgain}</button>}
      {said.elsewhere && onCompanies && <button type="button" className="btn btn-secondary" onClick={onCompanies}>{COMPANIES.another}</button>}
      {said.elsewhere && onMac && <button type="button" className="btn btn-secondary" onClick={onMac}>{COMPANIES.useMac}</button>}
    </Problem>)}
  </>;
  const guide = provider === "other"
    ? <>
      <ol className="ai-steps">{KEY.otherSteps.map(s => <li key={s}><div><p>{s}</p></div></li>)}</ol>
      <div className="ai-fields">
        <div className="field">
          <label htmlFor="ai-other-address">{KEY.address}</label>
          <input id="ai-other-address" className="input" inputMode="url" autoComplete="off" spellCheck={false} value={other.baseUrl} aria-describedby="ai-other-help"
            onChange={e => setOther({ ...other, baseUrl: e.target.value.trim() })} />
          <p id="ai-other-help" className="ai-small">{KEY.addressHelp}</p>
        </div>
        <div className="field">
          <label htmlFor="ai-other-model">{KEY.modelName}</label>
          <input id="ai-other-model" className="input" autoComplete="off" spellCheck={false} value={other.model} onChange={e => setOther({ ...other, model: e.target.value.trim() })} />
        </div>
        {addressProblem && <p className="problem" role="alert">{KEY.addressProblem}</p>}
      </div>
    </>
    : <ol className="ai-steps">{KEY.steps(provider, info).map(s => <li key={s.page}><div>
      <p>{s.text}</p>
      {s.note && <p className="ai-body">{s.note}</p>}
      <StepDrawing step={s} company={COMPANY_WORDS[provider].company} />
      <p className="ai-small ai-caption">{KEY.drawingCaption}</p>
      <button type="button" className="btn btn-secondary" onClick={() => open(s.page)}>{s.button}</button>
    </div></li>)}</ol>;
  return <Screen title={KEY.title(provider)}>
    <p className="ai-body">{KEY.intro(provider)}</p>
    {/* It works: the success line and the way back together at the top, with a different key still one press away; the
        guide, no longer needed, folds away (live in the release app, 2026-11-18). */}
    {works && said && <div className="ai-head">
      <Ok lines={[said.text]} />
      <div className="ai-actions">
        <button type="button" className="btn btn-primary ai-primary" onClick={onDone}>{done}</button>
        <Quiet onClick={paste}>{KEY.pasteDifferent}</Quiet>
      </div>
    </div>}
    {!works && provider !== "other" && (kept || usedKept) && <div className="ai-head">
      {kept && <>
        <p className="ai-body">{KEY.keptLede(provider)}</p>
        <div className="ai-actions"><button type="button" className="btn btn-primary ai-primary" disabled={busy} onClick={() => tryKept(provider)}>{KEY.useKept}</button></div>
      </>}
      {usedKept && outcome}
    </div>}
    {works ? <details className="ai-more">
      <summary><Icon name="chev" small />{KEY.stepsAgain}</summary>
      {guide}
    </details> : guide}
    {pageProblem && <Problem text={AI.browserFailed} calm />}
    {provider !== "other" && <p className="ai-body">{KEY.cost(provider, info?.typical_month ?? null)}</p>}
    <div className="ai-head">
      <p className="ai-body">{KEY.sends(provider, day.day, info?.retention_line ?? null)}</p>
      <Quiet onClick={() => setSent(true)}>{AI.seeSent}</Quiet>
    </div>
    {!works && <p className="ai-body">{viaClipboard ? KEY.askClipboard : KEY.askWindow}</p>}
    {provider === "gemini" && <p className="ai-body">{KEY.geminiPlan}</p>}
    {!works && !usedKept && outcome}
    {!works && <div className="ai-actions">
      {/* One primary per screen: with a key kept, it is "Use the key already on this Mac" above, and this one is secondary. */}
      <button type="button" className={kept ? "btn btn-secondary" : "btn btn-primary ai-primary"} disabled={busy} onClick={paste}>{kept ? KEY.pasteDifferent : KEY.paste}</button>
      <Quiet onClick={onBack}>{AI.back}</Quiet>
      <Quiet onClick={onLater}>{AI.later}</Quiet>
    </div>}
    {sent && <SentSheet onClose={() => setSent(false)} />}
  </Screen>;
}
