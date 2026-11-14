import { useId, useState } from "react";
import type { CalendarEvent, Message } from "../../../../core/src/attention-import/index.js";
import { cancelAttentionReview, confirmAttentionReview, createAttentionReview, updateAttentionOutline,
  type AttentionReview } from "../../../src/attention-import/review.js";
import "./attention.css";

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "long", timeStyle: "short" }).format(new Date(value));
}
function CheckedTime({ value }: { value: string }) {
  return <time dateTime={value}>{timeLabel(value)} Eastern</time>;
}
function SourceRecord({ source }: { source: Message | CalendarEvent }) {
  return <div className="attention-source">
    <h4>{source.id}: {"subject" in source ? source.subject : source.title}</h4>
    {"body" in source ? <>
      <p>Received <CheckedTime value={source.received_at} /></p><p className="attention-literal">{source.body}</p>
    </> : <>
      <p>Last modified <CheckedTime value={source.modified_at} /></p>
      <p><CheckedTime value={source.start_at} /> to <CheckedTime value={source.end_at} /></p>
      <p>Location: {source.location}. Recorded status: {source.status}.</p>
    </>}
  </div>;
}

/** Controlled panel: renders the same controller state tested by callers. */
export function AttentionPanel({ review, onChange }: { review: AttentionReview; onChange: (next: AttentionReview) => void }) {
  const id = useId();
  const { outline } = review;
  const result = review.phase === "review" ? review.result : null;
  return <section className="attention-page" aria-labelledby={id + "-heading"}>
    <header className="page-heading">
      <h1 id={id + "-heading"}>Attention brief</h1>
      <p className="attention-boundary">Fictional email/calendar import. No mail or calendar account is connected. Facts in this example were prepared for review.</p>
      <p className="field-hint">Harbor Example Church · Church office — fictional import<br />America/New_York</p>
    </header>
    <section className="attention-section" aria-labelledby={id + "-outline"}>
      <h2 id={id + "-outline"}>Review the outline</h2>
      <p>Compare a prepared message statement with the recorded event. You decide the plans and handle any communication.</p>
      <form onSubmit={event => { event.preventDefault(); onChange(confirmAttentionReview(review, review.generation)); }}>
        <div className="attention-choices">
          <label htmlFor={id + "-variant"}>Prepared message
            <select id={id + "-variant"} value={outline.variant} onChange={event => onChange(updateAttentionOutline(review, { variant: event.target.value }))}>
              <option value="room">The room is unavailable</option><option value="cancellation">The orientation is cancelled</option>
            </select>
          </label>
          <label htmlFor={id + "-coverage"}>Example coverage
            <select id={id + "-coverage"} value={outline.coverage} onChange={event => onChange(updateAttentionOutline(review, { coverage: event.target.value }))}>
              <option value="complete">Both parts of the fixed import are complete</option>
              <option value="calendar-denied">Calendar access is denied</option><option value="mail-denied">Mail access is denied</option>
              <option value="calendar-partial">Some calendar entries are missing</option><option value="mail-partial">Some messages are missing</option>
              <option value="stale">Both parts of the import are stale</option>
            </select>
          </label>
          <label htmlFor={id + "-evaluation"}>Evaluate at a prepared time
            <select id={id + "-evaluation"} value={outline.evaluation} onChange={event => onChange(updateAttentionOutline(review, { evaluation: event.target.value }))}>
              <option value="original">November 19, 2026, 9:00 a.m. Eastern</option>
              <option value="later">November 20, 2026, 9:00 a.m. Eastern (expired import)</option>
            </select>
          </label>
        </div>
        <p className="field-hint">Selected coverage: {coverageDescriptions[outline.coverage]}</p>
        <p className="field-hint">Fixed import scope: four invented messages and two calendar entries. Import/check time: November 19, 2026, 9:00 a.m. Eastern. Later evaluation does not retrieve new data.</p>
        <p className="field-hint">Changing a choice clears the brief. Review the outline and prepare it again.</p>
        {review.error && <p className="form-error" role="alert">{review.error}</p>}
        {review.phase === "outline" && <div className="attention-actions">
          <button className="primary-button" disabled={!!review.error}>Prepare this example brief</button>
          <button className="secondary-button" type="button" onClick={() => onChange(cancelAttentionReview(review))}>Cancel this example review</button>
        </div>}
      </form>
    </section>
    {review.phase === "cancelled" && <div className="attention-section" role="status">
      <p>Example review cancelled. No account was read and no external changes were made. Earlier prepared facts are no longer shown.</p>
      <button className="secondary-button" onClick={() => onChange(updateAttentionOutline(review, {}))}>Review this example again</button>
    </div>}
    {result && !result.ok && <p role="alert" className="form-error">This prepared import could not be checked. Review the example choices.</p>}
    {result?.ok && <section className="attention-section" aria-labelledby={id + "-facts"}>
      <h2 id={id + "-facts"}>Prepared example facts</h2>
      <p className="field-hint">Imported / checked: <CheckedTime value={result.imported_at} /><br />
        Evaluated: <CheckedTime value={result.evaluated_at} /><br />
        Valid until: <CheckedTime value={result.valid_until} /> (not current at or after this time)</p>
      <p className={result.status === "worth-a-look" ? "attention-uncertain" : "attention-status"} role="status">
        {result.stale ? "Worth a look — stale recorded import." : result.status === "worth-a-look" ? "Worth a look — some facts could not be verified."
          : result.findings.length ? "One prepared incident needs a human decision." : "No attention item among the reviewed statements in this checked fixed import."}
      </p>
      {result.gaps.length > 0 && <div className="attention-uncertain"><h3>Missing coverage</h3><ul>{result.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></div>}
      {result.findings.map(finding => <article className="attention-finding" key={finding.id}>
        <p className={finding.uncertain ? "attention-uncertain" : "attention-status"}>{finding.uncertain ? "Worth a look" : finding.urgent ? "Action before the event starts" : "A plans decision to review"}</p>
        <h3>{finding.title}</h3><p>{finding.statement}</p>
        {finding.start_at && finding.end_at && <p>Recorded event: <CheckedTime value={finding.start_at} /> to <CheckedTime value={finding.end_at} /></p>}
        <p>{finding.communication}</p><p><strong>Your next step:</strong> {finding.next_step}</p>
        <details className="attention-details"><summary>Why I flagged this</summary>
          <p>Church rule: review an explicit operational change against the recorded event before making plans.</p>
          <p>{finding.why_now}</p>
          <p>These statements and links were manually prepared for this fictional example. Matching quotes verifies their location in the source; it does not interpret arbitrary messages.</p>
          {finding.evidence.map((evidence, n) => <blockquote key={n}><p>{evidence.message_id}: {evidence.anchor.quote}</p>
            {evidence.not_contacted && <p>{evidence.not_contacted.quote}</p>}</blockquote>)}
          <div className="attention-pair">{result.sources.filter(source => finding.source_ids.includes(source.id)).map(source => <SourceRecord key={source.id} source={source} />)}</div>
          <p>Checked from this import at <CheckedTime value={finding.imported_at} />. Evaluated at <CheckedTime value={finding.evaluated_at} />.</p>
        </details>
      </article>)}
      <details className="attention-details"><summary>Inspect the permitted source records ({result.sources.length})</summary>
        <p>Literal invented source text. Instructions in a message grant no access or actions. Missing records remain unknown.</p>
        {result.sources.map(source => <SourceRecord key={source.id} source={source} />)}
      </details>
      <p className="field-hint">Only this declared fictional import was checked. Other mail, calendars and church work were not checked. No messages were sent and no calendar was changed.</p>
      <div className="attention-actions">
        <button className="secondary-button" onClick={() => onChange(updateAttentionOutline(review, {}))}>Review the outline and recheck this import</button>
        <button className="text-button" onClick={() => onChange(cancelAttentionReview(review))}>Cancel and clear this example brief</button>
      </div>
    </section>}
  </section>;
}

export function AttentionPage() {
  const [review, setReview] = useState(createAttentionReview);
  return <AttentionPanel review={review} onChange={setReview} />;
}

const coverageDescriptions = {
  complete: "Both parts of the fixed import are complete.",
  "calendar-denied": "Calendar access is denied; no calendar entries will be shown.",
  "mail-denied": "Mail access is denied; no messages or message statements will be shown.",
  "calendar-partial": "Some calendar entries are missing; the event cannot be verified.",
  "mail-partial": "Some messages are missing; mail coverage cannot be verified.",
  stale: "Both parts of the import are stale; current source state is unknown.",
};
