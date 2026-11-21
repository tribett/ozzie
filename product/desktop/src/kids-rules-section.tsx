import type { SundayRules } from "../../../core/src/sunday-capture.js";
import type { DayWords } from "./day-words.js";
import { SERVICES } from "./day-phrases.js";
import { backgroundChecksOn, KIDS_DEFAULT_MIN, KIDS_MAX_MIN, KIDS_MAX_TEAMS, kidsTeams, withKidsBackgroundChecks, withKidsTeam } from "../../../core/src/kids-rules.js";

/**
 * Church rules for kids teams. No team is assumed: the church marks each one, up to KIDS_MAX_TEAMS. Changing a
 * count re-checks what was already read; the background-check rule needs the next check to read People. Teams
 * marked earlier that aren't on the Sunday checked last are still listed, so they can be removed.
 */
export function KidsTeamsRules({ rules, onChange, teams }: {
  rules: SundayRules; onChange: (r: SundayRules) => void;
  /** The watched service's day words (Church rules passes `useDay()`); the Sunday words otherwise. */
  words?: DayWords;
  /** Teams from the last check: team id and its position names. */
  teams: [string, string[]][];
}) {
  const marked = kidsTeams(rules);
  const full = marked.length >= KIDS_MAX_TEAMS;
  const minFor = (team: string) => marked.find(t => t.team_id === team)?.min_confirmed ?? null;
  const elsewhere = marked.filter(t => !teams.some(([team]) => team === t.team_id));
  const count = (team: string, label: string, min: number) => <div className="row rule-row kids-count">
    <label htmlFor={`kids-min-${team}`}>Confirmed at each time</label>
    <input id={`kids-min-${team}`} type="number" min={1} max={KIDS_MAX_MIN} value={min} aria-label={`Confirmed people ${label} needs at each service time`}
      onChange={e => onChange(withKidsTeam(rules, team, Number(e.target.value)))} />
    <span className="small">confirmed people, not counting pending</span>
  </div>;
  return <section className="find rule-kids" aria-labelledby="kids-rules-title">
    <h2 id="kids-rules-title" className="h3">Kids teams</h2>
    <p className="find-body">Mark the teams that serve with children, and how many confirmed people each needs at every service time. Pending isn't counted. Ozzie counts confirmed people on the team; it doesn't check ages.</p>
    {teams.length === 0 && <p className="small">Check {SERVICES} first to see their teams.</p>}
    {teams.map(([team, positionNames]) => {
      const min = minFor(team), name = positionNames.join(", "), label = `${name} team`;
      return <div className="rule-team" key={team}>
        <label className="confirmation" htmlFor={`kids-${team}`}>
          <input id={`kids-${team}`} type="checkbox" checked={min !== null} disabled={min === null && full}
            onChange={e => onChange(withKidsTeam(rules, team, e.target.checked ? KIDS_DEFAULT_MIN : null, name))} />
          <span>{label} serves with kids</span>
        </label>
        {min !== null && count(team, label, min)}
      </div>;
    })}
    {full && <p className="small">That's {KIDS_MAX_TEAMS} kids teams, the most Ozzie checks. Unmark one to mark another.</p>}
    {elsewhere.map(t => <div className="rule-team" key={t.team_id}>
      <div className="row rule-row">
        <span className="bold">{t.name ? `${t.name} team` : "A team marked earlier"}</span>
        <span className="small">Not on the service checked last. {t.min_confirmed} confirmed at each time.</span>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => onChange(withKidsTeam(rules, t.team_id, null))}>Unmark this team</button>
      </div>
    </div>)}
    {marked.length > 0 && <div className="rule-team kids-background">
      <label className="confirmation" htmlFor="kids-background">
        <input id="kids-background" type="checkbox" checked={backgroundChecksOn(rules)}
          onChange={e => onChange(withKidsBackgroundChecks(rules, e.target.checked))} />
        <span>Ask for a current background check before anyone serves on these teams</span>
      </label>
      <p className="small">For each check of your services, Ozzie reads only whether each person scheduled on these teams has a current background check in Planning Center People, never its details. If you turn on adding people in Settings, adding someone to one of these teams also reads that person's background check status and end date first, even with this off. It needs People in your Planning Center connection, and it's read on the next check. What it finds stays in Ozzie on this Mac: it's never sent to an AI.</p>
    </div>}
  </section>;
}
