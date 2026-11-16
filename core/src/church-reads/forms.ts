// People forms: for each form the leader chose to watch, how many new submissions Planning Center
// People shows since the window began (the 8 days before the check), and who submitted, by person id.
// Pure: no I/O, no model. Names are resolved on this Mac at render time from the capture's names; a
// submitted answer is never read at all. A form not fully read is listed as not checked, never none.
import { churchZone } from "../church-time.js";
import type { SundayCapture, SundayRead, SundayRules } from "../sunday-capture.js";
import { applyFeedback, feedbackOf, type CorrectionEntry, type FeedbackTarget, type StopEntry } from "../finding-feedback.js";
import { answered, bodyRows, earliest, instant, isId, labelOf, link, plural, REASON, rowId, stateOf, unique } from "./common.js";
import { whenIn } from "./words.js";

export const FORMS_SOURCE = "Planning Center People";
export const FORMS_KIND = "form-submissions";

export interface FormFact {
  form_id: string; name: string | null;
  count: number;
  /** The read was partial: at least `count` submissions. */
  at_least: boolean;
  /**
   * Whom the submissions are for, by Planning Center person id, first first: only people Planning Center says aren't
   * children (the native read keeps no other). Names resolve on this Mac only.
   */
  submitters: string[];
  /** Submissions counted with no person kept: a child's, or one whose person Planning Center didn't say isn't a child. */
  unnamed: number;
  /** The submissions counted, by id: what a "This isn't right" entry is about. */
  submissions: string[];
  since: string; since_words: string; until: string;
  checked_at: string; source: string; title: string;
}
export interface FormsFacts {
  source: string;
  /** False when the connection doesn't include People, so no form was read. */
  connected: boolean;
  forms: FormFact[];
  hidden?: { kind: string; key: string; entry: StopEntry | CorrectionEntry }[];
  /** Every form Planning Center listed, for choosing in Church rules. Names are local only. */
  listed: { form_id: string; name: string | null }[];
  not_checked: string[];
  checked_at: string | null;
}

/**
 * "This isn't right" sets this count aside while the same submissions stand, whatever day the window starts; a new
 * submission (or one leaving the window) brings it back.
 */
export const formTarget = (f: FormFact): FeedbackTarget => ({
  kind: FORMS_KIND, key: `form:${f.form_id}`, occurrence: "new-submissions", facts: JSON.stringify([f.submissions, f.at_least]), tone: "look", scope: {},
  labels: { occurrence: "while the same submissions stand" },
});

/** `zone`: where the church's time zone wasn't read, the zone dates are shown in (the Mac's). */
export function formsFacts(capture: SundayCapture, rules: SundayRules, options: { zone?: string } = {}): FormsFacts | null {
  const reads = (collection: string) => capture.reads.filter(r => r.collection === collection);
  const listReads = reads("people_forms"), submissionReads = reads("people_form_submissions");
  if (capture.forms === undefined && !listReads.length && !submissionReads.length) return null;
  const church = churchZone(capture).zone;
  const zone = church ?? options.zone ?? "UTC";
  const listState = stateOf(listReads);
  if (listState === "not-requested") {
    return { source: FORMS_SOURCE, connected: false, forms: [], listed: [], checked_at: null,
      not_checked: ["People forms weren't checked: this Planning Center connection doesn't include People. Allow Calendar, People and Groups in Settings."] };
  }
  const not_checked: string[] = listState === "ok" ? [] : [`People forms: ${REASON[listState]}.`];
  const used: SundayRead[] = listReads.filter(answered);
  const listed = unique(bodyRows(used).map(r => rowId(r, "Form")).filter(isId)).map(form_id => ({ form_id, name: labelOf(capture, "form", form_id) }));
  const forms: FormFact[] = [];
  let missing = 0;
  for (const form_id of (capture.forms ?? []).filter(isId)) {
    if (!listed.some(f => f.form_id === form_id)) { if (listState === "ok") missing++; continue; }
    const name = labelOf(capture, "form", form_id);
    const own = submissionReads.filter(r => r.form_id === form_id);
    const state = stateOf(own);
    const since = instant(own[0]?.window?.starts_at), until = instant(own[0]?.window?.ends_at);
    if ((state !== "ok" && state !== "truncated") || !since || !until) {
      not_checked.push(`New submissions for ${name ?? "a form you watch"}: ${REASON[state === "ok" || state === "truncated" ? "failed" : state]}.`);
      continue;
    }
    used.push(...own);
    const rows = bodyRows(own).filter(r => rowId(r, "FormSubmission") && link(r, "form", "Form") === form_id);
    const submissions = unique(rows.map(r => r.id as string));
    const count = submissions.length;
    const at_least = state === "truncated";
    // The window starts part-way through a day, so its hour is named too.
    const since_words = whenIn(since, zone);
    forms.push({
      form_id, name, count, at_least, since, since_words, until, checked_at: earliest(own)!, source: FORMS_SOURCE, submissions,
      submitters: unique(rows.map(r => link(r, "person", "Person")).filter(isId)),
      unnamed: rows.filter(r => !isId(link(r, "person", "Person"))).length,
      title: count === 0 && !at_least ? `${name ?? "A form you watch"}: no new submissions since ${since_words}`
        : `${name ?? "A form you watch"}: ${at_least ? "at least " : ""}${plural(count, "new submission")} since ${since_words}`,
    });
  }
  if (!church && forms.length) not_checked.push("Dates for forms are in this Mac's time zone: the church's time zone wasn't read.");
  if (missing) {
    not_checked.push(missing === 1 ? "1 form you watch isn't in Planning Center's list of forms any more. It may have been archived."
      : `${missing} forms you watch aren't in Planning Center's list of forms any more. They may have been archived.`);
  }
  const kept = applyFeedback(forms, formTarget, feedbackOf(rules));
  return { source: FORMS_SOURCE, connected: true, forms: kept.shown, listed, not_checked, checked_at: earliest(used),
    ...(kept.hidden.length ? { hidden: kept.hidden.map(h => ({ kind: FORMS_KIND, key: `form:${h.item.form_id}`, entry: h.entry })) } : {}) };
}
