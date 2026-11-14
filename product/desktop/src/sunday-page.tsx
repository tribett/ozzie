import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { BriefPerson, Finding, SundayBrief } from "../../../core/src/sunday-brief.js";
import type { ServingInterval } from "../../../core/src/coverage.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { FollowUpFinding, OperationsResult, RoomFinding } from "../../../core/src/operations-findings/index.js";
import { operationsNotChecked, type GroupMeeting, type SundayOperations } from "../../../core/src/operations-capture.js";
import { Icon } from "./icons.js";
import { acceptModelReply, buildRewordRequest, restoreDraft, templateDraft, REWORDINGS, type PlaceholderDraft, type Rewording } from "../../../core/src/draft-request.js";
import { canEscalate, escalationDraft, restoreEscalation } from "../../../core/src/escalation-draft.js";
import {
  applyDecisions, changeText, decide, decisionsStorageKey, loadDecisions, openCount, REASON_MAX, saveDecisions, withDecision, withoutDecision,
  type DecidedItem, type DecisionChoice, type DecisionHistory, type SundayDecision,
} from "../../../core/src/sunday-decisions.js";
import { model, modelProblem } from "./model.js";

type Names = Record<string, string>;
const nameOf = (names: Names, id: string | undefined) => (id && Object.hasOwn(names, id) && names[id]) || "Someone on the team";
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const when = (i: ServingInterval | null) => i ? `${new Date(i.starts_at).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} at ${clock(i.starts_at)}` : "this Sunday";
const plainReasons: [RegExp, string][] = [
  [/^Recorded team membership.*/, "On this team in Planning Center. No blockout or other schedule overlaps this time."],
  [/^Possible conflict: source records an unanswered sent request\./, "Has an unanswered request for another role at this time."],
  [/^Possible conflict: unconfirmed scheduling record; invitation not sent\./, "Is penciled in for another role at this time; that request hasn't been sent."],
  [/^Possible conflict: unconfirmed scheduling record; sending couldn't be verified\./, "Is also pending for another role at this time."],
  [/^Confirmed overlapping serving assignment\./, "Already confirmed to serve somewhere else at this time."],
  [/^Recorded overlapping blockout\./, "Has a blockout that covers this time."],
  // The engine checks a person's schedules and blockouts as one read scope: if either read fails, both are unconfirmed.
  [/^Blockouts couldn't be verified\./, "Their blockouts couldn't be checked (one repeats, or the read didn't finish)."],
  [/^Serving assignments couldn't be verified\./, "Their other schedules couldn't be confirmed."],
  [/^Recorded availability couldn't be verified\./, "Part of their Planning Center record didn't load, so availability isn't confirmed."],
  [/^(Team membership|Required role eligibility) couldn't be verified\./, "Their place on this team couldn't be confirmed (part of the team's record didn't load)."],
  [/^Required related scope couldn't be verified\./, "Part of this check didn't load."],
  [/^Required serving interval couldn't be verified\./, "This service time couldn't be confirmed."],
];
const plain = (reasons: string[]) => [...new Set(reasons.map(r => plainReasons.find(([re]) => re.test(r))?.[1] ?? r))].join(" ");
/** Unranked: alphabetical by the name shown, so the order never implies priority. */
const unranked = (people: BriefPerson[], names: Names) => [...people].sort((a, b) => nameOf(names, a.person_id).localeCompare(nameOf(names, b.person_id)));
const alphabetical = (ids: string[], names: Names) => [...ids].sort((a, b) => nameOf(names, a).localeCompare(nameOf(names, b)));

const CHOICE_TEXT: Record<DecisionChoice, { button: string; question: string; save: string; done: (role: string) => string; earlier: string }> = {
  "covered-outside": { button: "Covered outside Planning Center", question: "Who or what is covering it?", save: "Mark it covered for this Sunday",
    done: role => `${role}: covered outside Planning Center.`, earlier: "covered outside Planning Center" },
  "not-needed": { button: "Not needed this Sunday", question: "Why isn't it needed this Sunday?", save: "Mark it not needed this Sunday",
    done: role => `${role} isn't needed this Sunday.`, earlier: "not needed this Sunday" },
  "lead-expected": { button: "Yes, that's expected", question: "Why is that expected?", save: "Mark it expected for this Sunday",
    done: role => `${role}: no scheduled lead expected this Sunday.`, earlier: "no scheduled lead expected" },
};

/** Decisions for the Sunday on screen, kept on this Mac per organization and plan. */
export function useSundayDecisions(capture: SundayCapture | null, brief: SundayBrief | null): [SundayDecision[], (next: SundayDecision[]) => void] {
  const key = capture && brief ? decisionsStorageKey(brief.mode, capture.organization, capture.plan_id) : null;
  const [decisions, setDecisions] = useState<SundayDecision[]>([]);
  useEffect(() => { setDecisions(key ? loadDecisions(localStore(), key) : []); }, [key]);
  return [decisions, next => { setDecisions(next); if (key) saveDecisions(localStore(), key, next); }];
}
function localStore(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** Which of Ozzie's procedures each kind of Sunday finding comes from (core/skills). */
export const PROCEDURE_FOR = {
  needs: "who-could-help", room: "room-check", followUp: "follow-up-owners", group: "group-night", overall: "sunday-ready",
} as const;
export const procedureFor = (finding: Finding) => finding.kind === "needs-people" ? PROCEDURE_FOR.needs : PROCEDURE_FOR.overall;
/** "See how this works" under Why I flagged this: opens the procedure on the Church rules page. */
function HowLink({ onHow }: { onHow: (() => void) | undefined }) {
  if (!onHow) return null;
  return <div className="why-how"><button type="button" className="btn btn-quiet btn-sm" onClick={onHow}><Icon name="rules" small /> See how this works</button></div>;
}

export function Why({ finding, checkedAt, onHow, defaultOpen = false }: { finding: Finding; checkedAt: string | null; onHow?: (() => void) | undefined; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <div className="find-src">
    <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="info" small /> Why I flagged this
    </button>
    <span className="badge b-muted">Planning Center</span>
    {checkedAt && <span>Checked {time(checkedAt)}</span>}
    {open && <ul className="list why">{finding.why.map(w => <li key={w}><Icon name="dot" small />{w}</li>)}</ul>}
    {open && <HowLink onHow={onHow} />}
  </div>;
}

/** When no one on the team can be listed: who else could help find someone. */
const noOneText = (finding: Finding) => finding.leaders?.length ? "You could ask the team's leader who else could help."
  : finding.leaders ? "Planning Center doesn't list a leader for this team." : "The team's leaders couldn't be read.";
/** Whether a needs-people finding has anyone to show, including people left out and why. */
const listsPeople = (finding: Finding) => {
  const p = finding.people;
  return Boolean(p && (p.suggestions.length || p.conflicts.length || p.unverified.length || p.left_out.length));
};

function PeopleList({ finding, names, onDraft }: { finding: Finding; names: Names; onDraft: (person: string) => void }) {
  const p = finding.people!;
  const [showLeft, setShowLeft] = useState(false);
  const row = (person: BriefPerson, note: string | null, canDraft: boolean, left = false) =>
    <div className={`person${left ? " is-left" : ""}`} key={person.person_id}>
      <Icon name={left ? "minus" : canDraft ? "user" : "question"} />
      <div>
        <div className="person-top">
          <span className="person-name">{nameOf(names, person.person_id)}</span>
          {note && <span className={`badge ${left ? "b-muted" : note === "Possible conflict" ? "b-conflict" : canDraft ? "b-confirm" : "b-look"}`}>{note}</span>}
          {canDraft && <button type="button" className="btn btn-secondary btn-sm push" onClick={() => onDraft(person.person_id)}>Prepare a note</button>}
        </div>
        <p className="person-role">{plain(person.reasons)}</p>
      </div>
    </div>;
  const none = !p.suggestions.length && !p.conflicts.length && !p.unverified.length;
  return <div className="stack people">
    <p className="small">People on this team in Planning Center. Listed alphabetically, not ranked. Whether someone is willing is theirs to say.</p>
    {unranked(p.suggestions, names).map(x => row(x, "No overlap found", true))}
    {unranked(p.conflicts, names).map(x => row(x, "Possible conflict", true))}
    {unranked(p.unverified, names).map(x => row(x, "Availability needs confirmation", false))}
    {none && <p className="find-body">{noOneText(finding)}</p>}
    {p.left_out.length > 0 && <>
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={showLeft} onClick={() => setShowLeft(!showLeft)}>
        {showLeft ? "Hide" : "Show"} {p.left_out.length} left out and why
      </button>
      {showLeft && unranked(p.left_out, names).map(x => row(x, "Left out", false, true))}
    </>}
  </div>;
}

function Draft({ finding, person, names, sender, canReword, onClose }: {
  finding: Finding; person: string; names: Names; sender: string; canReword: boolean; onClose: () => void;
}) {
  const ctx = { finding, person_id: person };
  const [version, setVersion] = useState<PlaceholderDraft>(() => templateDraft(ctx, names));
  const [body, setBody] = useState(() => restoreDraft(version, ctx, names, sender));
  const [edited, setEdited] = useState(false);
  const [working, setWorking] = useState<Rewording | null>(null);
  const [problem, setProblem] = useState("");
  const reword = async (choice: Rewording) => {
    setWorking(choice); setProblem("");
    try {
      const reply = await model.reword(buildRewordRequest(version, choice, names));
      const next = acceptModelReply(reply, version, names);
      setVersion(next); setBody(restoreDraft(next, ctx, names, sender)); setEdited(false);
    } catch (error) {
      setProblem(error instanceof Error && /draft|name|Ozzie/.test(error.message) ? error.message : modelProblem(error));
    } finally { setWorking(null); }
  };
  return <DraftBox label="Draft note" body={body} onBody={b => { setBody(b); setEdited(true); }} onClose={onClose}
    footer="Ozzie never sends messages. The AI sees placeholders like [Volunteer A] instead of the names Ozzie read from Planning Center.">
    {canReword && <div className="find-next reword">
      <span className="find-next-l">Ask Ozzie to reword it</span>
      {(Object.keys(REWORDINGS) as Rewording[]).map(choice => <button key={choice} type="button" className="chip" disabled={working !== null} onClick={() => { void reword(choice); }}>
        {working === choice ? <Icon name="spinner" small spin /> : null}{({ warmer: "Warmer", shorter: "Shorter", casual: "More casual", formal: "More formal" })[choice]}</button>)}
    </div>}
    {canReword && edited && <p className="small">Rewording starts from Ozzie's last version. Your own changes stay on this Mac and are never sent.</p>}
    {problem && <p role="alert" className="problem">{problem}</p>}
  </DraftBox>;
}

/** The shared draft frame: never a send button, only copy and change the wording. */
function DraftBox({ label, to, body, onBody, onClose, footer, children }: {
  label: string; to?: string; body: string; onBody: (b: string) => void; onClose: () => void; footer: string; children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  return <div className="draft" role="region" aria-label={label}>
    <div className="row draft-head"><span className="badge b-draft">Draft only. Nothing has been sent.</span><span className="spacer" />
      <button type="button" className="ibtn" aria-label="Close the draft" onClick={onClose}><Icon name="x" /></button></div>
    {to && <p className="small draft-to">To {to}</p>}
    {editing
      ? <textarea className="draft-edit" value={body} onChange={e => { onBody(e.target.value); setCopied(false); }} rows={9} autoFocus />
      : <div className="draft-body">{body.split("\n\n").map((para, i) => <p key={i}>{para}</p>)}</div>}
    <div className="find-next">
      <button type="button" className="btn btn-primary" onClick={() => { void navigator.clipboard?.writeText(body).then(() => setCopied(true)); }}>
        {copied ? "Copied — send it yourself" : "Copy draft"}</button>
      <button type="button" className="btn btn-secondary" onClick={() => setEditing(!editing)}>{editing ? "Done changing" : "Change the wording"}</button>
    </div>
    {children}
    <p className="small">{footer}</p>
  </div>;
}

/** A note to the team's leader. Written on this Mac in placeholder form and never offered for AI rewording. */
export function LeaderNote({ finding, leader, names, sender, onClose }: { finding: Finding; leader: string; names: Names; sender: string; onClose: () => void }) {
  const ctx = { finding, leader_id: leader };
  const [body, setBody] = useState(() => restoreEscalation(escalationDraft(ctx), ctx, names, sender));
  return <DraftBox label="Draft note to the team's leader" to={`${nameOf(names, leader)} (team leader in Planning Center)`} body={body} onBody={setBody} onClose={onClose}
    footer="Ozzie never sends messages. This note was written on this Mac; nothing in it went to an AI." />;
}

function LeaderButtons({ finding, names, label, onPick }: { finding: Finding; names: Names; label: string; onPick: (leader: string) => void }) {
  const leaders = alphabetical(finding.leaders ?? [], names);
  if (!canEscalate(finding)) return null;
  return <>{leaders.map(l => <button key={l} type="button" className="btn btn-secondary btn-sm" onClick={() => onPick(l)}>
    {leaders.length === 1 ? label : `${label}: ${nameOf(names, l)}`}</button>)}</>;
}

/** A short reason, required, for a Sunday-only decision. */
export function DecisionForm({ choice, onSave, onCancel }: { choice: DecisionChoice; onSave: (reason: string) => void; onCancel: () => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState("");
  const text = CHOICE_TEXT[choice];
  return <form className="decide" onSubmit={e => {
    e.preventDefault();
    try { onSave(reason); } catch (error) { setProblem(error instanceof Error ? error.message : "That couldn't be saved."); }
  }}>
    <label className="field-l" htmlFor={id}>{text.question}</label>
    <input id={id} className="input" value={reason} maxLength={REASON_MAX} autoFocus placeholder="A few words, for example: a parent from the class is covering"
      onChange={e => { setReason(e.target.value); setProblem(""); }} />
    <p className="input-help">Kept on this Mac. It applies to this Sunday only, and this comes back if Planning Center changes.</p>
    {problem && <p role="alert" className="problem">{problem}</p>}
    <div className="find-next">
      <button type="submit" className="btn btn-primary btn-sm" disabled={!reason.trim()}>{text.save}</button>
      <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>Never mind</button>
    </div>
  </form>;
}

function Earlier({ decision }: { decision: SundayDecision }) {
  return <ul className="list earlier">
    {[...decision.earlier, decision].map(d => <li key={d.decided_at + d.reason}><Icon name="history" small />
      <span>Earlier, you said {CHOICE_TEXT[d.choice].earlier} ({time(d.decided_at)}): “{d.reason}”</span></li>)}
  </ul>;
}

function FindingCard({ item, names, checkedAt, sender, canReword, onDecide, onHow }: {
  item: DecidedItem; names: Names; checkedAt: string | null; sender: string; canReword: boolean;
  onDecide: (finding: Finding, choice: DecisionChoice, reason: string, previous: SundayDecision | null) => void;
  onHow?: ((procedure: string) => void) | undefined;
}) {
  const { finding } = item;
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [leaderFor, setLeaderFor] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<DecisionChoice | null>(null);
  const [open, setOpen] = useState(finding.kind === "needs-people");
  const hasPeople = listsPeople(finding);
  const decision = finding.tone === "decision";
  const tag = item.state === "reopened"
    ? <span className="badge b-attn"><Icon name="flag" small />This needs attention again</span>
    : <span className={`badge ${decision ? "b-attn" : "b-look"}`}><Icon name={decision ? "flag" : "eye"} small />{decision ? "Needs a decision" : "Worth a look"}</span>;
  const where = finding.position ? <span className="find-where">{finding.position.name} · {when(finding.position.interval)}</span> : null;
  let title: string, body: string | null = null;
  switch (finding.kind) {
    case "needs-people":
      title = `${finding.position!.name} still needs ${finding.remaining === 1 ? "one more person" : `${finding.remaining} more people`}.`;
      { const n = finding.people!.suggestions.length, c = finding.people!.conflicts.length;
        body = n + c === 0 ? "No one else on this team is clear for this time."
          : n === 0 ? `No one else on the team is clear with no overlap found; ${c === 1 ? "one person has" : `${c} people have`} a possible conflict.`
            : `${n === 1 ? "One person" : `${n} people`} on the team could help with no overlap found${c ? `, and ${c} with a possible conflict` : ""}.`; }
      break;
    case "pending":
      title = `${nameOf(names, finding.person_id)} is pending for ${finding.position!.name}.`;
      body = finding.notification === "sent" ? "The request was sent; there's no answer yet." : "Planning Center shows the request hasn't been sent yet. Is that expected?";
      break;
    case "streak":
      title = `${nameOf(names, finding.person_id)} is scheduled ${finding.sundays} Sundays in a row.`;
      body = "Your Church rules suggest a quick check-in. This is about care, not performance.";
      break;
    case "lead-missing":
      title = `No one is scheduled to lead ${finding.position!.name} this Sunday.`;
      body = finding.leaders?.length ? "I found the team's leader in Planning Center, but no one scheduled to lead this Sunday. Is that expected?"
        : finding.leaders ? "Your Church rules ask for a scheduled lead, and Planning Center doesn't list a team leader. Is that expected?"
          : "Your Church rules ask for a scheduled lead. The team's leaders couldn't be read. Is that expected?";
      break;
    case "lead-unverified":
      title = `I couldn't confirm the scheduled lead for ${finding.position!.name}.`;
      body = "Planning Center has someone scheduled to lead, but their answer or serving time couldn't be confirmed, so I'm not counting it as covered.";
      break;
    default:
      title = finding.stale ? "This check is out of date." : "Part of this Sunday couldn't be checked.";
      body = finding.stale ? `It was read ${checkedAt ? time(checkedAt) : "earlier"}, more than 30 minutes ago. Check Planning Center again before relying on it.`
        : "Ozzie won't call Sunday covered until every part is read.";
  }
  const choices: DecisionChoice[] = finding.kind === "needs-people" ? ["covered-outside", "not-needed"] : finding.kind === "lead-missing" ? ["lead-expected"] : [];
  return <article className={`find${finding.tone === "look" && item.state === "open" ? " is-look" : ""}${item.state === "reopened" ? " is-reopened" : ""}`}>
    <div className="find-top">{tag}{where}</div>
    <h3 className="find-title">{title}</h3>
    {body && <p className="find-body">{body}</p>}
    {item.state === "reopened" && item.decision && <div className="panel-warn reopen" role="note">
      <Icon name="history" />
      <div className="stack-tight">
        <p className="bold">What changed since you decided</p>
        <ul className="list">{item.changes.map(c => <li key={c.code}><Icon name="dot" small />{changeText(c, id => nameOf(names, id))}</li>)}</ul>
        <Earlier decision={item.decision} />
      </div>
    </div>}
    {finding.unread && <ul className="list unread">{finding.unread.map(u => <li key={u}><Icon name="question" small />{u}</li>)}</ul>}
    {finding.kind === "needs-people" && <>
      {/* No one to list: no show/hide toggle, just what could help instead. */}
      {!hasPeople && <p className="find-body">{noOneText(finding)}</p>}
      {(hasPeople || canEscalate(finding)) && <div className="find-next">
        {hasPeople && <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide people" : "See who could help"}</button>}
        <LeaderButtons finding={finding} names={names} label="Prepare a note to the team's leader" onPick={l => { setLeaderFor(l); setDraftFor(null); }} />
      </div>}
      {hasPeople && open && <PeopleList finding={finding} names={names} onDraft={p => { setDraftFor(p); setLeaderFor(null); }} />}
      {draftFor && <Draft key={draftFor} finding={finding} person={draftFor} names={names} sender={sender} canReword={canReword} onClose={() => setDraftFor(null)} />}
    </>}
    {choices.length > 0 && !choosing && <div className="find-next">
      {finding.kind === "needs-people" && <span className="find-next-l">Or, for this Sunday only:</span>}
      {choices.map(c => <button key={c} type="button" className={`btn btn-sm ${finding.kind === "lead-missing" ? "btn-primary" : "btn-secondary"}`} onClick={() => setChoosing(c)}>{CHOICE_TEXT[c].button}</button>)}
      {finding.kind === "lead-missing" && <LeaderButtons finding={finding} names={names} label="Prepare a note to the leader" onPick={setLeaderFor} />}
    </div>}
    {choosing && <DecisionForm key={choosing} choice={choosing} onCancel={() => setChoosing(null)}
      onSave={reason => { onDecide(finding, choosing, reason, item.decision); setChoosing(null); }} />}
    {leaderFor && <LeaderNote key={leaderFor} finding={finding} leader={leaderFor} names={names} sender={sender} onClose={() => setLeaderFor(null)} />}
    <Why finding={finding} checkedAt={checkedAt} onHow={onHow ? () => onHow(procedureFor(finding)) : undefined} />
  </article>;
}

const remainingText = (n: number) => `Planning Center still shows ${n === 1 ? "1 remaining request" : `${n} remaining requests`}; Ozzie hasn't changed anything there.`;

function ResolvedCard({ item, checkedAt, onUndo }: { item: DecidedItem; checkedAt: string | null; onUndo: () => void }) {
  const d = item.decision!, f = item.finding;
  return <article className="find is-resolved">
    <div className="find-top"><span className="badge b-you"><Icon name="user" small />Resolved by you — this Sunday only</span>
      {f.position && <span className="find-where">{f.position.name} · {when(f.position.interval)}</span>}</div>
    <h3 className="find-title">{CHOICE_TEXT[d.choice].done(d.subject.name)}</h3>
    <p className="find-quote">“{d.reason}”</p>
    <p className="find-body">You decided this {time(d.decided_at)}. {f.kind === "needs-people" ? remainingText(f.remaining ?? 0) : "Planning Center still shows no confirmed lead; Ozzie hasn't changed anything there."}</p>
    {d.earlier.length > 0 && <ul className="list earlier">{d.earlier.map(e => <li key={e.decided_at + e.reason}><Icon name="history" small />
      <span>Before that, you said {CHOICE_TEXT[e.choice].earlier} ({time(e.decided_at)}): “{e.reason}”</span></li>)}</ul>}
    <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={onUndo}>Undo — bring it back to the list</button></div>
    <Why finding={f} checkedAt={checkedAt} />
  </article>;
}

function HistoryCard({ entry, onRemove }: { entry: DecisionHistory; onRemove: () => void }) {
  const d = entry.decision;
  const where = <span className="find-where">{d.subject.name} · {when(d.subject.interval)}</span>;
  if (entry.status === "source-confirmed") return <article className="find is-resolved">
    <div className="find-top"><span className="badge b-ok"><Icon name="check" small />Confirmed in Planning Center</span>{where}</div>
    <h3 className="find-title">{d.kind === "lead-missing" ? `Planning Center now shows a confirmed lead for ${d.subject.name}.` : `${d.subject.name} is now filled in Planning Center.`}</h3>
    <p className="find-body">{entry.checked_at ? `Checked ${time(entry.checked_at)}.` : ""} Your earlier note is kept below as history.</p>
    <Earlier decision={d} />
    <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={onRemove}>Remove my note</button></div>
  </article>;
  const note = entry.status === "filled-pending" ? `Planning Center now shows no open requests for ${d.subject.name}, but someone there hasn't accepted yet.`
    : entry.status === "not-listed" ? `Planning Center no longer lists ${d.subject.name} on this plan.`
      : `This couldn't be rechecked in Planning Center, so it stands as your decision, not as confirmed coverage.`;
  return <article className="find is-resolved">
    <div className="find-top"><span className="badge b-you"><Icon name="user" small />Resolved by you — this Sunday only</span>
      {entry.status === "couldnt-recheck" && <span className="badge b-look"><Icon name="eye" small />Worth a look</span>}{where}</div>
    <h3 className="find-title">{CHOICE_TEXT[d.choice].done(d.subject.name)}</h3>
    <p className="find-quote">“{d.reason}”</p>
    <p className="find-body">You decided this {time(d.decided_at)}. {note}</p>
    <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={onRemove}>Undo — remove my decision</button></div>
  </article>;
}

const span = (i: { starts_at: string; ends_at: string }) => `${clock(i.starts_at)}–${clock(i.ends_at)}`;
const uncertaintyText: Partial<Record<string, string>> = {
  "unknown-rule": "A room isn't set as not shared in Church rules, so overlaps there can't be confirmed.",
  "unknown-booking": "A booking's status or time couldn't be read.",
  "unknown-resolution": "Planning Center doesn't show clearly whether overlapping bookings (counting any setup time) were already worked out.",
  "unknown-card": "A follow-up's step, owner or due date couldn't be read.",
  "snooze-recheck": "A snoozed follow-up's snooze has ended and needs a fresh look.",
};

export function OpsWhy({ evidence, why, onHow, defaultOpen = false }: { evidence: OperationsResult["checked_scopes"]; why: string[]; onHow?: (() => void) | undefined; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // Only Planning Center reads have a check time; Church rules are the church's own settings.
  const at = evidence.filter(e => e.source !== "church-rule").map(e => e.check_time).sort()[0];
  const sources = [...new Set(evidence.map(e => e.source === "church-rule" ? "Church rules" : e.source === "normalized-calendar" ? "Calendar" : "People follow-ups"))];
  return <div className="find-src">
    <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="info" small /> Why I flagged this</button>
    {sources.map(s => <span key={s} className="badge b-muted">{s}</span>)}{at && <span>Checked {time(at)}</span>}
    {open && <ul className="list why">{why.map(w => <li key={w}><Icon name="dot" small />{w}</li>)}</ul>}
    {open && <HowLink onHow={onHow} />}
  </div>;
}

const CLEAR: Record<string, string> = {
  "rooms,follow-ups": "No room overlaps or follow-ups without an owner in what was read",
  rooms: "No room overlaps in what was read", "follow-ups": "No follow-ups without an owner in what was read",
};
/** Whether the rooms and follow-ups slot has anything to show: a result, an out-of-date state, or a fully checked "nothing found". */
export const hasOperationsSection = (operations: SundayOperations | null): operations is SundayOperations =>
  Boolean(operations && (operations.stale || operations.result || operations.clear.length));

/**
 * Rooms and follow-ups for this Sunday. An out-of-date check shows only that it's out of date. The
 * "nothing found" line appears only when the operations check says every part was fully read, and
 * names only those parts, with the time Planning Center was read (never a Church-rules time).
 */
export function OperationsSection({ operations, onHow, whyOpen = false }: {
  operations: SundayOperations; onHow?: ((procedure: string) => void) | undefined;
  /** Start with every Why I flagged this open (tests). */
  whyOpen?: boolean;
}) {
  const how = (procedure: string) => onHow ? () => onHow(procedure) : undefined;
  const { labels, result } = operations;
  if (operations.stale) return <section className="stack" aria-label="Rooms and follow-ups">
    <h2 className="h3">Rooms and follow-ups</h2>
    <article className="find is-look">
      <div className="find-top"><span className="badge b-look"><Icon name="clock" small />Out of date</span></div>
      <h3 className="find-title">Rooms, follow-ups and group meetings aren't shown.</h3>
      <p className="find-body">This check was read more than 30 minutes ago, so Ozzie doesn't treat it as current. Check Planning Center again to see them.</p>
    </article>
  </section>;
  const label = (id: string, fallback: string) => (Object.hasOwn(labels, id) && labels[id]) || fallback;
  // Parts that couldn't be read are listed under What I didn't check; only open questions about what was read show here.
  const unchecked = new Set(result?.unchecked_scope_ids ?? []);
  const uncertainties = (result?.uncertainties ?? []).filter(u => u.scope_id === null || !unchecked.has(u.scope_id));
  const clear = CLEAR[operations.clear.join(",")];
  const room = (f: RoomFinding) => {
    const [a, b] = f.bookings;
    const confirmed = f.label === "Room use needs review";
    const why = [
      ...(f.rule?.exclusive ? [`Your Church rules say ${label(f.resource_id, "this room")} isn't shared${f.rule.additional_setup_minutes ? ` and needs ${f.rule.additional_setup_minutes} minutes of setup` : ""}.`]
        : ["No Church rule says this room isn't shared, so this overlap can't be confirmed."]),
      ...f.bookings.map(x => `The calendar shows ${label(x.booking_id, "a booking")} as ${x.status}, ${span(x.original)}.`),
      f.resolution?.state === "unresolved" ? "Planning Center Calendar lists these two bookings as a conflict that hasn't been resolved."
        : "Planning Center doesn't show clearly whether these two bookings were worked out.",
    ];
    return <article className={`find${confirmed ? "" : " is-look"}`} key={f.finding_id}>
      <div className="find-top"><span className={`badge ${confirmed ? "b-attn" : "b-look"}`}><Icon name={confirmed ? "flag" : "eye"} small />{f.label}</span>
        <span className="find-where">{label(f.resource_id, "A room")} · {when(f.overlap)}</span></div>
      <h3 className="find-title">{label(f.resource_id, "A room")} has overlapping bookings from {span(f.overlap)}.</h3>
      {a && b && <p className="find-body">{label(a.booking_id, "One booking")} ({span(a.original)}) and {label(b.booking_id, "another booking")} ({span(b.original)}) overlap
        {f.additional_setup_minutes ? `, counting the ${f.additional_setup_minutes} minutes of setup your Church rules set for this room` : ""}.</p>}
      <div className="find-next"><span className="find-next-l">Next step</span><span>{f.next_action}</span></div>
      <OpsWhy evidence={f.evidence} why={why} onHow={how(PROCEDURE_FOR.room)} defaultOpen={whyOpen} />
    </article>;
  };
  const followUp = (f: FollowUpFinding) => <article className="find" key={f.finding_id}>
    <div className="find-top"><span className="badge b-attn"><Icon name="flag" small />{f.label}</span>
      <span className="find-where">{label(f.workflow_id, "A follow-up")}</span></div>
    <h3 className="find-title">“{label(f.step_id, "A follow-up step")}” has no owner. It was due {time(f.due_at)}.</h3>
    <div className="find-next"><span className="find-next-l">Next step</span><span>{f.next_action}</span></div>
    <OpsWhy evidence={f.evidence} why={["This follow-up is active and ready on its current step.", "No one is assigned to it, and it isn't snoozed.", `Its due date, ${time(f.due_at)}, has passed.`]}
      onHow={how(PROCEDURE_FOR.followUp)} defaultOpen={whyOpen} />
  </article>;
  return <section className="stack" aria-label="Rooms and follow-ups">
    <h2 className="h3">Rooms and follow-ups</h2>
    {result?.findings.map(f => f.kind === "room-overlap" ? room(f) : followUp(f))}
    {uncertainties.length > 0 && <article className="find is-look">
      <div className="find-top"><span className="badge b-look"><Icon name="eye" small />Worth a look</span></div>
      <h3 className="find-title">Some room or follow-up details couldn't be confirmed.</h3>
      <ul className="list unread">{[...new Set(uncertainties.map(u => uncertaintyText[u.code] ?? "Part of the room and follow-up check couldn't be read."))]
        .map(t => <li key={t}><Icon name="question" small />{t}</li>)}</ul>
    </article>}
    {clear && <p className="small">{clear}{operations.checked_at ? ` (checked ${time(operations.checked_at)})` : ""}.</p>}
  </section>;
}

function GroupMeetingCard({ item, names, onHow, defaultOpen = false }: { item: GroupMeeting; names: Names; onHow?: (() => void) | undefined; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const roles = [...new Set(item.serving.map(s => s.position ?? "their role"))].join(", ");
  const serving = [...new Set(item.serving.map(s => `${s.status} for ${s.position ?? "a role"}`))].join(" and ");
  const why = [
    ...item.meetings.map(m => `Planning Center Groups lists them in a group that meets ${span(m)} this Sunday.`),
    ...item.serving.map(s => `Planning Center Services has them ${s.status} for ${s.position ?? "a role"}, ${span(s.interval)}.`),
    "This is a schedule fact. Which one they go to is theirs to decide.",
  ];
  return <article className="find is-look">
    <div className="find-top"><span className="badge b-look"><Icon name="eye" small />Worth a look</span>
      {item.serving[0] && <span className="find-where">{roles} · {when(item.serving[0].interval)}</span>}</div>
    <h3 className="find-title">{nameOf(names, item.person_id)} has a group meeting at the same time.</h3>
    <p className="find-body">Their group meets {item.meetings.map(span).join(" and ")}, while they're {serving}.</p>
    <div className="find-src">
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="info" small /> Why I flagged this</button>
      <span className="badge b-muted">Groups</span><span className="badge b-muted">Planning Center</span><span>Checked {time(item.checked_at)}</span>
      {open && <ul className="list why">{why.map(w => <li key={w}><Icon name="dot" small />{w}</li>)}</ul>}
      {open && <HowLink onHow={onHow} />}
    </div>
  </article>;
}

/** People on this plan whose group meets while they serve. Listed alphabetically, never ranked; names resolve on this Mac. */
export function GroupMeetings({ items, names, onHow, whyOpen = false }: { items: GroupMeeting[]; names: Names; onHow?: ((procedure: string) => void) | undefined; whyOpen?: boolean }) {
  return <section className="stack" aria-label="Group meetings">
    <h2 className="h3">Group meetings</h2>
    {[...items].sort((a, b) => nameOf(names, a.person_id).localeCompare(nameOf(names, b.person_id)))
      .map(m => <GroupMeetingCard key={m.person_id} item={m} names={names} defaultOpen={whyOpen}
        onHow={onHow ? () => onHow(PROCEDURE_FOR.group) : undefined} />)}
  </section>;
}

export function SundayPage(props: {
  brief: SundayBrief | null; names: Names; busy: boolean; problem: string; sender: string;
  connected: boolean; hasRecording: boolean; configured: boolean; canReword: boolean;
  decisions: SundayDecision[]; onDecisions: (next: SundayDecision[]) => void;
  operations: SundayOperations | null;
  onCheck: () => void; onRecording: () => void; onExample: () => void; onLaterExample?: (() => void) | undefined;
  /** "See how this works" under Why I flagged this: opens that procedure on the Church rules page. */
  onHow?: ((procedure: string) => void) | undefined;
}) {
  const { brief, names, decisions, onDecisions } = props;
  const stamp = useMemo(() => brief?.checked_at ? time(brief.checked_at) : null, [brief]);
  const view = useMemo(() => brief ? applyDecisions(brief, decisions) : null, [brief, decisions]);
  const counts = view ? openCount(view) : { decisions: 0, looks: 0, resolved: 0 };
  const incomplete = Boolean(brief && (brief.stale || brief.findings.some(f => f.kind === "worth-a-look")));
  // Incomplete checks first, then anything that came back, then Planning Center's order.
  const rank = (i: DecidedItem) => i.finding.kind === "worth-a-look" ? 0 : i.state === "reopened" ? 1 : 2;
  const open = view ? view.items.filter(i => i.state !== "resolved").sort((a, b) => rank(a) - rank(b)) : [];
  const resolved = view ? view.items.filter(i => i.state === "resolved") : [];
  const history = view?.history ?? [];
  const onDecide = (finding: Finding, choice: DecisionChoice, reason: string, previous: SundayDecision | null) =>
    onDecisions(withDecision(decisions, decide(finding, choice, reason, new Date().toISOString(), previous)));
  return <div className="col">
    <p className="eyebrow">{brief?.plan.dates ?? "This Sunday"}</p>
    <h1 className="h1">Is Sunday covered?</h1>
    {brief?.mode === "recording" && <p className="banner dashed"><Icon name="clock" small />Saved recording from {time(brief.completed_at)}. This is not a current check.</p>}
    {brief?.mode === "fictional" && <p className="banner dashed"><Icon name="info" small />Fictional example. No church data is shown.</p>}
    {brief && <p className="lede">
      {brief.stale ? "This check is out of date, so it isn't a current picture. " : incomplete ? "Part of this Sunday couldn't be checked, so this isn't a full picture. " : ""}
      {brief.status === "checked-scope-clear" ? "Everything Ozzie checked is covered. " :
        `${counts.decisions ? `${counts.decisions} ${counts.decisions === 1 ? "thing needs" : "things need"} a decision` : incomplete ? "Nothing in what was read needs a decision" : "Nothing needs a decision"}${counts.looks ? ` and ${counts.looks} ${counts.looks === 1 ? "is" : "are"} worth a look` : ""}. `}
      {counts.resolved + history.length > 0 && `You resolved ${counts.resolved + history.length} yourself. `}
      {brief.plan.title && <span className="muted">{brief.plan.title}.</span>}
    </p>}
    {!brief && <p className="lede">Sunday hasn't been checked yet. Check Planning Center now, or look around the fictional example first.</p>}
    {stamp && <p className="checkline"><Icon name="check" small />{brief!.mode === "fictional" ? "Fictional example data" : brief!.mode === "recording" ? "Recorded from Planning Center Services" : "Read from Planning Center Services"} · {brief!.sources.reads} reads · {stamp}{brief!.sources.failed.length ? ` · ${brief!.sources.failed.length} didn't complete` : ""}</p>}
    <div className="row">
      <button type="button" className="btn btn-primary" disabled={props.busy || !props.connected || !props.configured} onClick={props.onCheck}>
        {props.busy ? <><Icon name="spinner" small spin />Checking Planning Center…</> : "Check Planning Center now"}</button>
      {props.hasRecording && <button type="button" className="btn btn-secondary" disabled={props.busy} onClick={props.onRecording}>Use the saved recording</button>}
      {!brief && <button type="button" className="btn btn-quiet" onClick={props.onExample}>See a fictional example</button>}
      {brief?.mode === "fictional" && props.onLaterExample && <button type="button" className="btn btn-quiet" onClick={props.onLaterExample}>See a later fictional check</button>}
    </div>
    {!props.connected && <p className="small">Connect Planning Center under Settings to check a real Sunday. Ozzie only reads; it changes nothing there.</p>}
    {props.connected && !props.configured && <p className="small">Choose which Sunday to check under Settings.</p>}
    {props.problem && <p role="alert" className="problem">{props.problem}</p>}
    {brief && <section className="stack" aria-labelledby="sunday-open-title">
      <h2 id="sunday-open-title" className="sr-only">Open for this Sunday</h2>
      {open.map(i => <FindingCard key={i.finding.key + i.state} item={i} names={names} checkedAt={brief.checked_at} sender={props.sender} canReword={props.canReword} onDecide={onDecide} onHow={props.onHow} />)}
      {brief.findings.length === 0 && <p className="lede">No open needs, pending requests or Church-rule check-ins in what was read.</p>}
      {brief.findings.length > 0 && open.length === 0 && <p className="lede">Everything left is something you resolved yourself, below.</p>}
    </section>}
    {(resolved.length > 0 || history.length > 0) && <section className="stack" aria-label="Resolved by you">
      <h2 className="h3">Resolved by you</h2>
      <p className="small">Your own decisions for this Sunday only. They aren't coverage in Planning Center, and they come back here if something there changes.</p>
      {resolved.map(i => <ResolvedCard key={i.finding.key} item={i} checkedAt={brief!.checked_at} onUndo={() => onDecisions(withoutDecision(decisions, i.finding.key))} />)}
      {history.map(h => <HistoryCard key={h.decision.key} entry={h} onRemove={() => onDecisions(withoutDecision(decisions, h.decision.key))} />)}
    </section>}
    {brief && hasOperationsSection(props.operations) && <OperationsSection operations={props.operations} onHow={props.onHow} />}
    {brief && props.operations && props.operations.group_meetings.length > 0 && <GroupMeetings items={props.operations.group_meetings} names={names} onHow={props.onHow} />}
    {brief && <section className="notchecked" aria-label="What I didn't check">
      <h2 className="h3">What I didn't check</h2>
      <ul className="list">{[...brief.not_checked, ...(props.operations ? props.operations.not_checked : operationsNotChecked(null))].map(n => <li key={n}><Icon name="dot" small />{n}</li>)}</ul>
    </section>}
  </div>;
}
