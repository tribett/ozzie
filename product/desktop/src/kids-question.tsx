// "Does {Nursery} serve with kids?" (onboarding spec §4.2): a "Worth a look" card on the Sunday page under the team
// whose name looks like a kids team (moments.ts `kidsTeamToAsk`), while no team is marked one. It never interrupts.
// "Yes" marks the team in Church rules with today's default, KIDS_DEFAULT_MIN confirmed people at each time, changeable
// there; "No" is remembered by the team's Planning Center id only, so this team isn't asked about again.
import { useId } from "react";
import { Icon } from "./icons.js";
import { moments as thisMac, type MomentsStore } from "./moments.js";
import { KIDS_DEFAULT_MIN, withKidsTeam } from "../../../core/src/kids-rules.js";
import type { SundayRules } from "../../../core/src/sunday-capture.js";
import { roleWithService } from "../../../core/src/sunday-brief.js";
import "./finish.css";

export const kidsQuestionTitle = (team: string) => `Does ${team} serve with kids?`;
/** The team as the question names it: with its service while more than one is watched ("Nursery (Youth Night)"). */
export const kidsTeamName = (team: string, service: string | null): string => roleWithService(team, service);
export const KIDS_BODY = "If it does, Ozzie can check that each service time has enough confirmed people on it, and, if you turn it on, that each person scheduled has a current background check on file.";
export const KIDS_YES = "Yes, it serves with kids";

/** "Yes": the team marked in Church rules with the default count (the page saves the rules it returns). */
export const markKidsTeam = (rules: SundayRules, teamId: string, teamName: string): SundayRules => withKidsTeam(rules, teamId, KIDS_DEFAULT_MIN, teamName);

export function KidsQuestion({ teamId, teamName, onYes, onNo, memory = thisMac }: {
  teamId: string; teamName: string;
  /** Marks the team (the page: `saveRules(markKidsTeam(rules, teamId, teamName))`). */
  onYes: (teamId: string) => void;
  /** After "No" is remembered here, the page may hide the card at once. */
  onNo?: (() => void) | undefined;
  /** Where "No" is kept (tests pass their own). */
  memory?: MomentsStore | undefined;
}) {
  const id = useId();
  return <section className="find kids-question" aria-labelledby={`${id}-t`} aria-describedby={`${id}-b`}>
    <div className="find-top"><span className="badge b-look"><Icon name="eye" small />Worth a look</span></div>
    <h3 id={`${id}-t`} className="find-title">{kidsQuestionTitle(teamName)}</h3>
    <p id={`${id}-b`} className="find-body">{KIDS_BODY}</p>
    <div className="find-next">
      <button type="button" className="btn btn-primary" onClick={() => onYes(teamId)}>{KIDS_YES}</button>
      <button type="button" className="btn btn-secondary" onClick={() => { memory.answerKids(teamId); onNo?.(); }}>No</button>
    </div>
  </section>;
}
