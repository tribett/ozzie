import { useId, useState, type FormEvent } from "react";
import { AttentionPage } from "./attention/panel.js";
import { confirmSundayReview, createSundayReview, exampleCheckTime, ministries,
  recordSundayDecision, sundayFindings, updateSundayOutline, type MinistryId, type SundayFinding } from "../../src/sunday-review.js";

type Page = "work" | "attention" | "rules" | "about";
type DecisionChoice = Parameters<typeof recordSundayDecision>[2];
const scheduleLabels = { original: "Original schedule: Nursery still needs one person", decline: "A Nursery assignment declines: two people still needed", filled: "Nursery records no remaining serving need" };
function checkTimeLabel(value: string): string {
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(value))} UTC`;
}

export function Workbench() {
  const [review, setReview] = useState(createSundayReview);
  const [page, setPage] = useState<Page>("work");
  const [appearance, setAppearance] = useState<"light" | "dark">("light");
  const [question, setQuestion] = useState("");
  const [notice, setNotice] = useState("");
  const findings = sundayFindings(review);
  const selected = ministries.filter(m => review.outline.ministryIds.includes(m.id));
  const unchecked = ministries.filter(m => !review.outline.ministryIds.includes(m.id));
  const recordDecision = (findingId: string, choice: DecisionChoice, reason: string) => {
    const next = recordSundayDecision(review, findingId, choice, reason);
    setReview(next);
    setNotice(next.error ? "" : "Your Sunday decision is recorded in this open example. The source schedule is unchanged.");
    return next.error === null;
  };
  const changeScope = (id: MinistryId, included: boolean) => {
    setReview(current => updateSundayOutline(current, { ministryIds: ministries.filter(m => m.id === id ? included : current.outline.ministryIds.includes(m.id)).map(m => m.id) }));
    setNotice("");
  };
  const ask = (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim()) return;
    setReview(current => updateSundayOutline(current, {}));
    setPage("work"); setQuestion("");
    setNotice("Sunday coverage is available in this walkthrough. Review the outline before running the example check.");
  };
  return <div className="app-shell" data-appearance={appearance}>
    <a className="skip-link" href="#main-content">Skip to your work</a>
    <aside className="side-rail" aria-label="Workspace navigation">
      <img className="brand" src={appearance === "dark" ? "/ozzie-white.svg" : "/ozzie.svg"} alt="Ozzie by FlockConnect" width="156" height="53" />
      <div className="workspace-label"><strong>Harbor Example Church</strong><span>Fictional workspace</span></div>
      <nav aria-label="Main">
        <button className={page === "work" ? "nav-current" : ""} aria-current={page === "work" ? "page" : undefined} onClick={() => setPage("work")}><span aria-hidden="true">◷</span>Your work</button>
        <button className={page === "attention" ? "nav-current" : ""} aria-current={page === "attention" ? "page" : undefined} onClick={() => setPage("attention")}><span aria-hidden="true">◷</span>Attention brief</button>
        <button className={page === "rules" ? "nav-current" : ""} aria-current={page === "rules" ? "page" : undefined} onClick={() => setPage("rules")}><span aria-hidden="true">☷</span>Church rules</button>
        <button className={page === "about" ? "nav-current" : ""} aria-current={page === "about" ? "page" : undefined} onClick={() => setPage("about")}><span aria-hidden="true">?</span>See how this works</button>
      </nav>
      <div className="rail-bottom"><p>Prepared work.<br />Human decisions.</p>
        <button className="appearance-button" onClick={() => setAppearance(current => current === "light" ? "dark" : "light")}>Use {appearance === "light" ? "dark" : "light"} appearance</button>
      </div>
    </aside>
    <main id="main-content" className="work-area" tabIndex={-1}>
      <div className="reading-column">
        {page !== "attention" && <div className="example-notice"><span className="example-dot" aria-hidden="true" /><span>Fictional walkthrough. No Planning Center account is connected to this example.</span></div>}
        {page === "attention" && <AttentionPage />}
        {page === "work" && <>
          <header className="page-heading"><p className="breadcrumb">Your work / Sunday</p><h1>Sunday coverage</h1><p className="page-description">The serving needs, unanswered assignments, and decisions in one place.</p></header>
          {review.phase === "outline" ? <section className="outline-panel" aria-labelledby="outline-heading">
            <div className="panel-heading"><span className="step-marker" aria-hidden="true">1</span><div><h2 id="outline-heading">Review the outline</h2><p>Choose what to include before the example is checked.</p></div></div>
            <form onSubmit={event => { event.preventDefault(); setReview(current => confirmSundayReview(current)); setNotice(""); }}>
              <div className="outline-date"><label htmlFor="sunday">Sunday</label><select id="sunday" value="2026-11-22" disabled aria-describedby="sunday-hint"><option value="2026-11-22">November 22, 2026</option></select><p id="sunday-hint" className="field-hint">This walkthrough contains one designed Sunday, from 9:15 to 10:45 a.m. Eastern.</p></div>
              <p className="field-hint">Designed source example: {scheduleLabels[review.outline.schedule]}.{review.outline.partialExample && ` ${ministries.find(m => m.id === review.outline.partialMinistry)?.name} cannot be checked.`}</p>
              <fieldset><legend>Ministries to check</legend><div className="ministry-options">{ministries.map(ministry => <label className="check-row" key={ministry.id}><input type="checkbox" checked={review.outline.ministryIds.includes(ministry.id)} onChange={event => changeScope(ministry.id, event.target.checked)} /><span>{ministry.name}</span></label>)}</div></fieldset>
              <div className="outline-summary"><div><h3>Rules applied</h3><ul><li>Show remaining serving requests.</li><li>Keep unanswered assignments separate.</li><li>{review.outline.welcomeLeadRequired ? "Welcome Team requires a scheduled Sunday lead." : "Welcome Team does not require a Sunday lead in this example."}</li></ul><button className="text-button" type="button" onClick={() => setPage("rules")}>Change church rules</button></div>
                <div><h3>Outside this check</h3><p>{unchecked.length ? `${unchecked.map(m => m.name).join(", ")}. ` : ""}Other ministries, availability, eligibility and conflicts are not checked here.</p><p>No messages will be prepared or sent.</p></div></div>
              {review.error && <p className="form-error" role="alert">{review.error}</p>}
              {!selected.length && <p className="field-hint">Choose at least one ministry to continue.</p>}
              <div className="panel-actions"><button className="primary-button" disabled={!selected.length}>Run the example check</button><span>Fictional data only</span></div>
            </form>
          </section> : <section className="review-sheet" aria-labelledby="sheet-heading">
            <div className="sheet-heading"><div><p className="check-status">{review.result?.status === "unverified" ? "Example check incomplete" : "Example checked"}</p><h2 id="sheet-heading">Sunday, November 22</h2><p>{selected.map(m => m.name).join(", ")}<br /><time dateTime={review.result?.evaluated_at ?? exampleCheckTime}>{review.result?.status === "unverified" ? "Fixed example attempt" : "Fixed example check"}: {checkTimeLabel(review.result?.evaluated_at ?? exampleCheckTime)}</time></p></div><button className="secondary-button" onClick={() => { setReview(current => updateSundayOutline(current, {})); setNotice(""); }}>Change the outline</button></div>
            {review.result?.status === "unverified" && <div className="incomplete-notice" role="status"><strong>Some coverage could not be checked.</strong><span>Unavailable information has not been treated as an empty schedule.</span></div>}
            {review.error && <p className="form-error sheet-error" role="alert">{review.error}</p>}
            <div className="findings-heading"><h3>{findings.length ? "Sunday review" : "Checked scope"}</h3><span>{findings.length ? `${findings.length} ${findings.length === 1 ? "item" : "items"}` : `${selected.length} ${selected.length === 1 ? "ministry" : "ministries"}`}</span></div>
            {findings.length ? <div className="findings-list">{findings.map(finding => <Finding key={finding.id} finding={finding} onChangeRule={() => setPage("rules")} onRecordDecision={recordDecision} />)}</div> : <div className="clear-state"><strong>No remaining requests or unanswered assignments in this checked scope.</strong><p>{selected.map(m => m.name).join(", ")} only. This does not establish coverage elsewhere.</p></div>}
            <p className="sheet-boundary">This is a fictional check. Nothing has been changed in Planning Center, and nothing has been sent.</p>
            <p className="sheet-boundary note-boundary">Notes stay only in this open example. Reloading starts over. No note is sent to Planning Center or a model.</p>
          </section>}
        </>}
        {page === "rules" && <>
          <header className="page-heading"><p className="breadcrumb">Your workspace / Church rules</p><h1>Church rules</h1><p className="page-description">Visible expectations, with the effect of a change kept clear.</p></header>
          <section className="rules-panel" aria-labelledby="rule-heading"><h2 id="rule-heading">Sunday leadership</h2><label className="check-row rule-control"><input type="checkbox" checked={review.outline.welcomeLeadRequired} onChange={event => { setReview(current => updateSundayOutline(current, { welcomeLeadRequired: event.target.checked })); setNotice("The example rule changed. Review the outline and check it again to update the findings."); }} /><span><strong>Welcome Team requires a Sunday lead</strong><small>A scheduled role for the checked serving interval. Team oversight alone does not establish Sunday coverage.</small></span></label><p className="field-hint">Applies to this walkthrough only. It does not change your church's schedule or save a lasting preference.</p><button className="primary-button" onClick={() => { setReview(current => updateSundayOutline(current, {})); setPage("work"); }}>Review the updated outline</button></section>
          <section className="rules-explanation"><h2>Facts stay separate from rules</h2><p>A remaining request comes from the example schedule. Changing a lead requirement does not fill a serving role, send an invitation, or turn an unanswered assignment into a confirmation.</p></section>
        </>}
        {page === "about" && <>
          <header className="page-heading"><p className="breadcrumb">Your workspace / How it works</p><h1>See how this works</h1><p className="page-description">An inspectable walkthrough of one Sunday check.</p></header>
          <section className="about-panel"><h2>Outline, then checked facts</h2><p>Review the Sunday, ministries and church rules first. The check then uses designed fictional observations to show remaining requests, required leadership and unanswered assignments separately.</p><h2>Source details stay with the finding</h2><p>Open “Why I flagged this” to see the rule, the inputs and the fixed example check time. Missing information stays uncertain.</p><h2>Your connections are separate</h2><p>This walkthrough does not contact Planning Center or a model. Private sign-in, live Sunday checks, candidate review and drafts are being finished separately.</p>
            <div className="example-scenario"><label htmlFor="example-schedule">Designed schedule change</label><select id="example-schedule" value={review.outline.schedule} onChange={event => { setReview(current => updateSundayOutline(current, { schedule: event.target.value as typeof current.outline.schedule })); setNotice("The designed schedule changed. Review the outline before checking it again."); }}>{Object.entries(scheduleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><p className="field-hint">These are fictional source observations. A new check uses the same Sunday and serving interval.</p></div>
            <label className="check-row"><input type="checkbox" checked={review.outline.partialExample} onChange={event => { setReview(current => updateSundayOutline(current, { partialExample: event.target.checked })); setNotice("The example source changed. Review the outline before checking again."); }} /><span><strong>Try an incomplete check</strong><small>Make one ministry's example source unavailable. Known findings and earlier Sunday notes stay separate from uncertainty.</small></span></label>
            <div className="example-scenario"><label htmlFor="unavailable-ministry">Example source to make unavailable</label><select id="unavailable-ministry" disabled={!review.outline.partialExample} value={review.outline.partialMinistry} onChange={event => setReview(current => updateSundayOutline(current, { partialMinistry: event.target.value as MinistryId }))}>{ministries.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
            <div className="example-actions"><button className="primary-button" onClick={() => { setReview(current => updateSundayOutline(current, {})); setPage("work"); }}>Review the example outline</button><button className="text-button" onClick={() => { setReview(createSundayReview()); setNotice("A new fictional example has started. Earlier notes are no longer shown."); }}>Restart example — clear shown notes</button></div>
          </section>
        </>}
        {page !== "attention" && notice && <p className="work-notice" role="status">{notice}</p>}
        {page !== "attention" && <form className="ask-form" onSubmit={ask}><label htmlFor="ask-ozzie">Ask Ozzie</label><div className="ask-controls"><input id="ask-ozzie" value={question} onChange={event => setQuestion(event.target.value)} placeholder="What would you like to get off your plate?" autoComplete="off" /><button className="secondary-button" disabled={!question.trim()}>Review Sunday</button></div><p>In this walkthrough, start with Sunday coverage. Nothing you type is sent to a model.</p></form>}
      </div>
    </main>
  </div>;
}

function Finding({ finding, onChangeRule, onRecordDecision }: { finding: SundayFinding; onChangeRule: () => void;
  onRecordDecision: (id: string, choice: DecisionChoice, reason: string) => boolean }) {
  const formId = useId();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<DecisionChoice | "">("");
  const [reason, setReason] = useState(finding.note ?? "");
  const resolved = finding.status === "resolved-by-you" || finding.status === "source-confirmed";
  return <article className={`finding-row${finding.uncertain ? " finding-uncertain" : resolved ? " finding-resolved" : ""}${finding.status === "source-confirmed" ? " finding-source-confirmed" : ""}`}>
    <div className="finding-status">{finding.label}<span>{finding.ministry}</span></div>
    <h4>{finding.title}</h4><p>{finding.description}</p>
    {finding.change && <div className="finding-change"><strong>What changed</strong><p>{finding.change}</p></div>}
    {finding.note && <aside className="decision-note" aria-label="Your Sunday decision"><strong>{finding.uncertain ? "Earlier Sunday note" : "Your Sunday note"}</strong><p>{finding.note}</p><small>{finding.uncertain ? "Your earlier note is retained. Current coverage could not be verified."
      : finding.status === "resolved-by-you" ? "Resolved by you. This does not change what the example source records."
        : finding.status === "source-confirmed" ? "Your earlier decision is kept separately from this source check."
          : "Your earlier note is retained. The changed coverage needs another decision."}</small></aside>}
    <details className="source-details"><summary>Why I flagged this</summary><div className="source-detail-body"><h5>Church rule</h5><p>{finding.rule}</p><h5>Inputs</h5><ul>{finding.inputs.map(input => <li key={input}>{input}</li>)}</ul><dl><dt>Source</dt><dd>{finding.source}</dd><dt>{finding.uncertain ? "Example attempt" : "Example check"}</dt><dd>{finding.checkTime ? <time dateTime={finding.checkTime}>{checkTimeLabel(finding.checkTime)}</time> : "Check time unavailable"}</dd>{finding.uncertain && finding.lastSuccessfulCheckTime && <><dt>Last successful example check</dt><dd><time dateTime={finding.lastSuccessfulCheckTime}>{checkTimeLabel(finding.lastSuccessfulCheckTime)}</time></dd></>}<dt>Serving interval</dt><dd>November 22, 9:15–10:45 a.m. Eastern</dd></dl>
      {finding.ministry === "Welcome Team" && <button className="text-button" onClick={onChangeRule}>This isn't right — change the rule</button>}
    </div></details>
    {finding.canRecordDecision && !editing && <button className="secondary-button decision-button" onClick={() => { setEditing(true); setChoice(""); }}>{finding.note ? "Change my Sunday decision" : "Record a Sunday-only decision"}</button>}
    {finding.canRecordDecision && editing && <form className="decision-form" aria-labelledby={`${formId}-heading`} onSubmit={event => { event.preventDefault(); if (choice && onRecordDecision(finding.id, choice, reason)) setEditing(false); }}>
      <h5 id={`${formId}-heading`}>Record this Sunday decision</h5><fieldset><legend>How was this handled?</legend>
        <label className="check-row"><input type="radio" name={formId} value="covered-outside-pco" checked={choice === "covered-outside-pco"} onChange={() => setChoice("covered-outside-pco")} autoFocus required /><span>Covered outside Planning Center</span></label>
        <label className="check-row"><input type="radio" name={formId} value="intentional-exception" checked={choice === "intentional-exception"} onChange={() => setChoice("intentional-exception")} required /><span>Intentional exception for this Sunday</span></label>
      </fieldset><label htmlFor={`${formId}-reason`}>Reason for this Sunday</label><textarea id={`${formId}-reason`} rows={3} value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} required aria-describedby={`${formId}-boundary`} />
      <p className="field-hint" id={`${formId}-boundary`}>Use only the reason you want recorded. Ozzie will keep your exact words in this open example. The source schedule stays unchanged.</p>
      <div className="decision-actions"><button className="primary-button" disabled={!choice || !reason.trim()}>Record my Sunday decision</button><button type="button" className="text-button" onClick={() => { setEditing(false); setChoice(""); setReason(finding.note ?? ""); }}>Keep the finding unchanged</button></div>
    </form>}
  </article>;
}
