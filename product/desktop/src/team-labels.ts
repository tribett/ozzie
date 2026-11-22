// How the pages name a team: by its positions' names in the last check ("Greeter team"; Ozzie reads no team names), and,
// with more than one service watched, with that team's service by its own Planning Center name ("Greeter team · Youth
// Night"), so two services' teams with the same roles are told apart (teams belong to one service type in Planning
// Center). Church rules, Church lists and the kids question all name teams this way (polish 2026-11-21). Local only, like
// every name a check read.
import { createContext, useContext } from "react";
import type { AlsoOperations } from "../../../core/src/operations-capture.js";
import type { PositionLabel } from "../../../core/src/sunday-capture.js";

/**
 * Each team's service by its own name, while more than one service is watched (App passes services-merge.ts
 * `teamServices`); undefined with one service, when no team needs its service said.
 */
export const TeamServicesContext = createContext<Readonly<Record<string, string>> | undefined>(undefined);
export const useTeamServices = (): Readonly<Record<string, string>> | undefined => useContext(TeamServicesContext);
/**
 * Each finding's service by its id in the merged brief, by a name a person would recognise, while more than one service is
 * watched (App passes services-merge.ts `findingServices`), for a part of the check with no role to say its service with
 * (Thursday's brief, the spoken briefing); undefined with one service.
 */
export const FindingServicesContext = createContext<Readonly<Record<string, string>> | undefined>(undefined);
export const useFindingServices = (): Readonly<Record<string, string>> | undefined => useContext(FindingServicesContext);

/** A team's service, when more than one service is watched and that service's name is known. */
export const serviceOfTeam = (team: string, services: Readonly<Record<string, string>> | undefined): string | null =>
  services && Object.hasOwn(services, team) ? services[team] ?? null : null;

/** "Greeter team", or "Greeter team · Youth Night" with more than one service watched. `name`: the team's positions' names. */
export function teamLabel(name: string, team: string, services?: Readonly<Record<string, string>>): string {
  const service = serviceOfTeam(team, services);
  return service ? `${name} team · ${service}` : `${name} team`;
}

/** Each team in the check by its id, named by its positions' names in the last check, as Church rules list it. */
export function teamNames(positions: readonly PositionLabel[], services?: Readonly<Record<string, string>>): Map<string, string> {
  const names = new Map<string, string[]>();
  for (const p of positions) names.set(p.team_id, [...new Set([...(names.get(p.team_id) ?? []), p.name])]);
  return new Map([...names].map(([team, list]) => [team, teamLabel(list.join(", "), team, services)]));
}

/**
 * With more than one service watched: the first service's name and each other service's own rooms and group meetings,
 * with the names the lines that speak of every service say them by (App passes services-merge.ts `alsoOperations`), for
 * Today, Thursday's brief and the spoken briefing; undefined with one service, which reads exactly as before.
 */
export const AlsoOperationsContext = createContext<AlsoOperations | undefined>(undefined);
export const useAlsoOperations = (): AlsoOperations | undefined => useContext(AlsoOperationsContext);
