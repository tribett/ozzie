import { useEffect, useState, type ReactNode } from "react";
import type { SundayRules } from "../../../core/src/sunday-capture.js";
import type { PositionLabel } from "../../../core/src/sunday-capture.js";
import { roomRules } from "../../../core/src/operations-capture.js";
import type { Skill } from "../../../core/src/harness/contract.js";
import { Icon } from "./icons.js";
import { churchList } from "./connection.js";
import { KidsTeamsRules } from "./kids-rules-section.js";
import { teamLabel, useTeamServices } from "./team-labels.js";
import { feedbackOf } from "../../../core/src/finding-feedback.js";
import { FromYourCards, useFeedback } from "./finding-feedback.js";
import { useDay } from "./day-words.js";
import { useSystemWords, type SystemWords } from "./church-system.js";
import { dayName, pageRef, procedurePurpose, SERVICES } from "./day-phrases.js";
import { procedureTitle } from "./harness-words.js";
import { ProcedureBody } from "./procedure-text.js";

/**
 * A room's rule, stored with the other rules. "Not shared" is the only room rule, with its setup
 * time; "No rule set" (null) stores nothing, never a "can be shared" rule.
 */
export function withRoomRule(rules: SundayRules, room_id: string, next: { setup_minutes: number } | null): SundayRules {
  return { ...rules, rooms: [...roomRules(rules).filter(r => r.room_id !== room_id), ...(next ? [{ room_id, exclusive: true, setup_minutes: next.setup_minutes }] : [])] };
}

export const PROCEDURES_TITLE = "What the AI is asked to do";
/**
 * What the AI is asked to do: each procedure the AI follows when Ozzie asks it for help, by title and purpose, with its
 * exact text under "See how this works" (the heading says what the text below it says: review H, L6). The title and
 * purpose name the service's real day; the text stays word for word (procedure-text.tsx). Read-only; a procedure can't
 * widen what Ozzie may read, and none changes Planning Center.
 */
export function HowOzzieChecks({ procedures, focus = null }: { procedures: readonly Skill[]; focus?: string | null }) {
  useEffect(() => {
    if (focus && typeof document !== "undefined") document.getElementById(`procedure-${focus}`)?.scrollIntoView?.({ block: "start" });
  }, [focus]);
  const d = useDay();
  return <section className="find how-checks" aria-labelledby="how-checks-title">
    <h2 id="how-checks-title" className="h3">{PROCEDURES_TITLE}</h2>
    <p className="find-body">These are the steps the AI follows when Ozzie asks it for help: answering a question in Ask, writing up a job Ozzie keeps an eye on, and looking at who could help with a role. Ozzie's own checks of {SERVICES} don't use them. They can't be changed here, and none of them changes anything in Planning Center.</p>
    {procedures.map(p => <div key={p.id} id={`procedure-${p.id}`} className="procedure">
      <p className="bold">{procedureTitle(p.title, d) ?? p.title}</p>
      <p className="small">{procedurePurpose(p.purpose, d)}</p>
      <details className="listen-more" open={focus === p.id}>
        <summary><Icon name="chev" small />See how this works</summary>
        <ProcedureBody body={p.body} />
      </details>
    </div>)}
  </section>;
}

/** What Church rules mean for a church on another system, in one plain paragraph. */
export const SYSTEM_RULES = (w: SystemWords) => w.system === "genesis"
  ? "With Genesis, Ozzie checks no service: Genesis doesn't share volunteer schedules. It shows the events coming up, how many attended the ones that have ended, your groups, and how many times each form was filled in. Rules for scheduled leads, kids teams and background checks, rooms, and serving many weeks in a row work with Planning Center only for now. Ozzie can't read background checks from Genesis."
  : `With ${w.name}, Ozzie checks what ${w.name} shares about the service: ${w.system === "breeze" ? "its roles, who answered, and how many people each needs where Breeze gives a number" : "its roles, how many people each needs and who answered"}${w.system === "b1" ? ", who on each role's team could help, and their blockouts" : ""}. Rules for scheduled leads, kids teams and background checks, rooms, and serving many weeks in a row work with Planning Center only for now. Ozzie can't read background checks from ${w.name}.`;

/** Church rules are the church's own settings. Changing one re-checks what was already read; it never reads or writes Planning Center. */
export function RulesPage({ rules, onChange, positions, leaders = {}, names = {}, rooms = [], procedures = null, focus = null, keptElsewhere = [], church = null }: {
  rules: SundayRules; onChange: (r: SundayRules) => void; positions: PositionLabel[];
  /** Team leaders Planning Center lists, by team (null when that read didn't complete). Names resolve on this Mac. */
  leaders?: Record<string, string[] | null>; names?: Record<string, string>;
  /** Rooms Planning Center Calendar listed in the last check. Names are local only. */
  rooms?: { room_id: string; name: string | null }[];
  /** Ozzie's procedures, in the order shown; null until loaded. */
  procedures?: readonly Skill[] | null;
  /** A procedure to open and bring into view (from a Sunday card's "See how this works"). */
  focus?: string | null;
  /** Churches whose rules for their own teams and rooms are kept aside while Ozzie uses another church. */
  keptElsewhere?: { organization: string; name?: string }[];
  /** People forms to watch and Check-Ins rooms matched to kids teams (church-reads-view.tsx). */
  church?: ReactNode;
}) {
  const d = useDay();
  const w = useSystemWords();
  // A church on another system: only what that system shares is checked; these rules need Planning Center's reads.
  const other = w.system !== "planning-center";
  // What the person told Ozzie on finding cards, kept with these rules; deleting one says so, with Undo.
  const { controls, notice } = useFeedback({ entries: feedbackOf(rules), onEntries: next => onChange({ ...rules, feedback: next }) }, names);
  const roomRule = (id: string) => roomRules(rules).find(r => r.room_id === id);
  const setRoom = (id: string, next: { setup_minutes: number } | null) => onChange(withRoomRule(rules, id, next));
  const teams = [...new Map(positions.map(p => [p.team_id, positions.filter(x => x.team_id === p.team_id).map(x => x.name)])).entries()];
  // With more than one service watched, each team says its service ("Greeter team · Youth Night"): two services' teams
  // with the same roles are told apart (polish 2026-11-21).
  const services = useTeamServices();
  // What the person typed, untrimmed, so a space between words survives; the rule itself is stored trimmed.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const leadFor = (team: string) => rules.sundayLeads.find(l => l.team_id === team)?.lead_position ?? "";
  const setLead = (team: string, value: string) => {
    setTyped(t => ({ ...t, [team]: value }));
    onChange({ ...rules, sundayLeads: [...rules.sundayLeads.filter(l => l.team_id !== team), ...(value.trim() ? [{ team_id: team, lead_position: value.trim() }] : [])] });
  };
  const leaderText = (team: string) => {
    const ids = Object.hasOwn(leaders, team) ? leaders[team] : undefined;
    if (ids === undefined) return null;
    if (ids === null) return "This team's leaders couldn't be read from Planning Center.";
    if (!ids.length) return "Planning Center doesn't list a leader for this team.";
    const who = ids.map(id => (Object.hasOwn(names, id) && names[id]) || "someone").join(", ");
    return `Planning Center lists ${who} as ${ids.length === 1 ? "this team's leader" : "this team's leaders"}. That's oversight, not someone scheduled to lead on ${dayName(d)}.`;
  };
  return <div className="col">
    <p className="eyebrow">Church rules</p>
    <h1 className="h1">How your church wants its services checked</h1>
    <p className="lede">These are your church's choices. Changing one updates {pageRef()} right away using what was already read. Nothing in {w.name} changes.</p>
    {other && <section className="find">
      <h2 className="h3">What Ozzie checks with {w.name}</h2>
      <p className="find-body">{SYSTEM_RULES(w)}</p>
    </section>}
    {keptElsewhere.length > 0 && <p className="banner"><Icon name="info" small /><span>Rules you set for the teams and rooms of {churchList(keptElsewhere)} are kept for {keptElsewhere.length === 1 ? "that church" : "those churches"} and don't apply here. They come back if Ozzie uses {keptElsewhere.length === 1 ? "that church" : "one of them"} again.</span></p>}
    {!other && <><section className="find">
      <h2 className="h3">Serving many weeks in a row</h2>
      <p className="find-body">Flag anyone confirmed this many weeks in a row, so a person can check in. It's about care, not performance.</p>
      <div className="row rule-row">
        <label htmlFor="streak">Weeks in a row</label>
        <input id="streak" type="number" min={0} max={12} value={rules.checkInAfterSundaysInARow}
          onChange={e => onChange({ ...rules, checkInAfterSundaysInARow: Math.max(0, Math.min(12, Number(e.target.value) || 0)) })} />
        <span className="small">{rules.checkInAfterSundaysInARow === 0 ? "Off" : `Flag at ${rules.checkInAfterSundaysInARow}`}</span>
      </div>
    </section>
    <section className="find">
      <h2 className="h3">{d.kind === "weekday" ? `${d.day} leads` : "Scheduled leads"}</h2>
      {/* Neutral before a church has said what it uses (polish 2026-11-21); Planning Center's own words once it has. */}
      <p className="find-body">{w.say(`If a team should always have a scheduled lead on ${dayName(d)}, choose the lead's position from the team's positions, or type its name as it appears in Planning Center. A team leader in Planning Center isn't the same as someone scheduled to lead.`)}</p>
      {teams.length === 0 && <p className="small">Check {SERVICES} first to see their teams.</p>}
      {teams.map(([team, positionNames]) => <div className="rule-team" key={team}>
        <div className="row rule-row">
          <label htmlFor={`lead-${team}`}>{teamLabel(positionNames.join(", "), team, services)}</label>
          {/* The team's position names from the last check, offered as choices; typing another name still works. */}
          <input id={`lead-${team}`} list={`lead-options-${team}`} autoComplete="off" value={typed[team] ?? leadFor(team)} placeholder="No scheduled lead required"
            onChange={e => setLead(team, e.target.value)} />
          <datalist id={`lead-options-${team}`}>{[...new Set(positionNames)].sort((a, b) => a.localeCompare(b)).map(n => <option key={n} value={n} />)}</datalist>
        </div>
        {leaderText(team) && <p className="small rule-note">{leaderText(team)}</p>}
      </div>)}
    </section>
    <KidsTeamsRules rules={rules} onChange={onChange} teams={teams} words={d} services={services} />
    {church}
    <section className="find rule-rooms">
      <h2 className="h3">Rooms</h2>
      <p className="find-body">Say which rooms can't hold two things at once, and how much setup time to allow before each booking. Rooms come from Planning Center Calendar; nothing there changes.</p>
      {rooms.length === 0 && <p className="small">Your rooms show here after a check that includes rooms. Turn that on in Settings.</p>}
      {rooms.map(room => {
        const rule = roomRule(room.room_id), name = room.name ?? "Unnamed room";
        return <div className="row rule-row" key={room.room_id}>
          <label htmlFor={`room-${room.room_id}`}>{name}</label>
          {/* The rule and its setup time are one group beside the room's name: in a narrow window the setup time wraps
              under the rule, and the number and its words always stay together. */}
          <div className="rule-room-controls">
            <select id={`room-${room.room_id}`} className="input" value={rule ? "exclusive" : "none"}
              onChange={e => setRoom(room.room_id, e.target.value === "exclusive" ? { setup_minutes: rule?.setup_minutes ?? 0 } : null)}>
              <option value="none">No rule set</option><option value="exclusive">Not shared</option>
            </select>
            <span className="rule-setup">
              <input type="number" min={0} max={240} aria-label={`Setup minutes for ${name}`} value={rule?.setup_minutes ?? 0} disabled={!rule}
                onChange={e => setRoom(room.room_id, { setup_minutes: Math.max(0, Math.min(240, Math.round(Number(e.target.value)) || 0)) })} />
              <span aria-hidden="true">minutes of setup</span>
            </span>
          </div>
        </div>;
      })}
      {rooms.length > 0 && <p className="small">For a room set as not shared, Ozzie counts its setup time before each booking and reads Calendar's own conflict records. An overlap Calendar lists as not yet resolved shows as Room use needs review. Overlaps in a room with no rule set, or that Ozzie can't confirm, show as Worth a look.</p>}
    </section></>}
    {notice}
    <FromYourCards feedback={controls} />
    {/* The AI's procedures read Planning Center's checks only (Ask, jobs, who could help): not shown for another system. */}
    {!other && procedures && procedures.length > 0 && <HowOzzieChecks procedures={procedures} focus={focus} />}
  </div>;
}
