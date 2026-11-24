// Church rules for kids on a church that uses B1 Church or Breeze (0.10.0, core church-systems/kids.ts): the same rule as
// Planning Center's Kids teams section (kids-rules-section.tsx), "at least N confirmed people at each service", marked
// on what the system really groups its roles by. B1 Church: its teams (the group each role draws its people from).
// Breeze: its roles, by name, since Breeze ties no team to them. Confirmed is who accepted there. Background checks aren't
// shared by either system, so there is no background-check rule here, and the section says so. Changing a mark or a count
// re-checks what was already read; nothing is read or written in the church's system.
import { KIDS_DEFAULT_MIN, KIDS_MAX_MIN, KIDS_MAX_TEAMS } from "../../../core/src/kids-rules.js";
import { B1_ACROSS_THE_SERVICE, KIDS_UNIT, systemKidsMarks, withSystemKids, type KidsChoice } from "../../../core/src/church-systems/kids.js";
import type { SundayRules } from "../../../core/src/sunday-capture.js";
import type { OtherSystem } from "./church-system.js";

/** The section's own words for each system, said once here and tested (product/desktop/test/system-kids.test.ts). */
export const SYSTEM_KIDS_WORDS: Readonly<Record<OtherSystem, {
  title: string; body: string; times: string; checks: string; none: string; untied?: (n: number) => string; full: string; unmark: string; earlier: string;
}>> = Object.freeze({
  b1: {
    title: "Kids teams",
    body: "Mark the B1 Church teams that serve with children, and how many confirmed people each needs at every service. A team is the group in B1 Church that a role draws its people from. Confirmed means they accepted in B1 Church; anyone who hasn't answered isn't counted. Ozzie counts confirmed people on the team; it doesn't check ages.",
    times: B1_ACROSS_THE_SERVICE,
    checks: "Ozzie can't read background checks from B1 Church, so this rule doesn't check them.",
    none: "Check your service first to see its teams.",
    untied: n => `${n === 1 ? "One role" : `${n} roles`} on the service ${n === 1 ? "has" : "have"} no team in B1 Church, so ${n === 1 ? "it can't" : "they can't"} be marked.`,
    full: `That's ${KIDS_MAX_TEAMS} kids teams, the most Ozzie checks. Unmark one to mark another.`,
    unmark: "Unmark this team",
    earlier: "A team marked earlier",
  },
  breeze: {
    title: "Kids roles",
    body: "Breeze doesn't tie a team to its roles, so mark the roles that serve with children, by name, and how many confirmed people each needs at every service. A mark holds for any Breeze event with a role of that name. Confirmed means they accepted in Breeze; anyone with no response yet isn't counted. Ozzie counts confirmed people on the role; it doesn't check ages.",
    times: "Ozzie counts everyone who accepted on the role for the service.",
    checks: "Ozzie doesn't read background checks from Breeze, so this rule doesn't check them.",
    none: "Check your service first to see its roles.",
    full: `That's ${KIDS_MAX_TEAMS} kids roles, the most Ozzie checks. Unmark one to mark another.`,
    unmark: "Unmark this role",
    earlier: "A role marked earlier",
  },
});

export function SystemKidsRules({ rules, onChange, system, church, choices, untied = 0 }: {
  rules: SundayRules; onChange: (r: SundayRules) => void;
  system: OtherSystem;
  /** The church the marks belong to: `<system>:<church id>` (church-systems placeholders.ts `placeholderScope`). */
  church: string;
  /** What the last check offers to mark (kids.ts `kidsChoices`); none before a check. */
  choices: readonly KidsChoice[];
  /** B1 Church: roles on the service with no team, which can't be marked. */
  untied?: number;
}) {
  const words = SYSTEM_KIDS_WORDS[system];
  const unit = KIDS_UNIT[system]!;
  const marked = systemKidsMarks(rules, church);
  const full = marked.length >= KIDS_MAX_TEAMS;
  const minFor = (id: string) => marked.find(t => t.id === id)?.min_confirmed ?? null;
  const elsewhere = marked.filter(t => !choices.some(c => c.id === t.id));
  const set = (id: string, min: number | null, name?: string) => onChange(withSystemKids(rules, church, id, min, name));
  const count = (key: string, id: string, label: string, min: number) => <div className="row rule-row kids-count">
    <label htmlFor={`kids-min-${key}`}>Confirmed at each service</label>
    <input id={`kids-min-${key}`} type="number" min={1} max={KIDS_MAX_MIN} value={min} aria-label={`Confirmed people ${label} needs at each service`}
      onChange={e => set(id, Number(e.target.value))} />
    <span className="small">people who accepted, not counting anyone who hasn't answered</span>
  </div>;
  return <section className="find rule-kids" aria-labelledby="system-kids-title">
    <h2 id="system-kids-title" className="h3">{words.title}</h2>
    <p className="find-body">{words.body}</p>
    <p className="small">{words.times}</p>
    {choices.length === 0 && <p className="small">{words.none}</p>}
    {choices.map((c, i) => {
      const min = minFor(c.id), key = `${system}-${i}`;
      return <div className="rule-team" key={c.id}>
        <label className="confirmation" htmlFor={`kids-${key}`}>
          <input id={`kids-${key}`} type="checkbox" checked={min !== null} disabled={min === null && full}
            onChange={e => set(c.id, e.target.checked ? KIDS_DEFAULT_MIN : null, c.name)} />
          <span>{c.name} serves with kids</span>
        </label>
        {unit === "team" && c.roles.length > 0 && c.roles.join(", ") !== c.name && <p className="small rule-note">Its roles: {c.roles.join(", ")}</p>}
        {min !== null && count(key, c.id, c.name, min)}
      </div>;
    })}
    {untied > 0 && words.untied && <p className="small">{words.untied(untied)}</p>}
    {full && <p className="small">{words.full}</p>}
    {elsewhere.map(t => <div className="rule-team" key={t.id}>
      <div className="row rule-row">
        <span className="bold">{t.name ?? words.earlier}</span>
        <span className="small">Not in the last check. {t.min_confirmed} confirmed at each service.</span>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => set(t.id, null)}>{words.unmark}</button>
      </div>
    </div>)}
    <p className="small">{words.checks}</p>
  </section>;
}
