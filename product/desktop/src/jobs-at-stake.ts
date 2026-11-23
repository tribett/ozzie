// What a switch of church does to the jobs in Keeping watch (owner decision 2026-11-22), for the switch questions' own
// text (connection.ts switchCopy, system-settings.tsx switchForgets): App provides every job this Mac keeps that hasn't
// ended (the runner's whole list, not only what the page shows) with the church each was confirmed for, and the Planning
// Center church in Settings. Each question counts only the jobs it will really ask about: those the new church's system
// runs, less the ones that simply resume there (confirmed for the church being returned to, or before any church was
// known). The rest wait until the Mac is back on Planning Center.
import { createContext } from "react";
import type { TemplateId } from "../../../core/src/harness/responsibilities.js";
import type { MainSystem } from "./church-system.js";
import type { JobChurch } from "./responsibility-runner.js";
import { runsOn } from "./system-jobs.js";

export interface JobAtStake { template: TemplateId; church: JobChurch | null }
export const JobsAtStakeContext = createContext<{ jobs: readonly JobAtStake[]; returning: string | null }>({ jobs: [], returning: null });
/**
 * Of the jobs this Mac keeps, how many a switch to `to` asks about, and how many wait (Genesis runs none). `returning`: the
 * church the switch is likely to come back to (Planning Center's in Settings, or the one a sign-in named), whose own jobs
 * resume with no question.
 */
export function jobsAtStake(jobs: readonly JobAtStake[], to: MainSystem | null, returning: string | null = null): { asked: number; waiting: number } {
  const system = to === "b1" || to === "breeze" ? to : null;
  const runs = to === "genesis" ? [] : jobs.filter(j => runsOn(j.template, system));
  const resumes = (j: JobAtStake) => Boolean(j.church && j.church.system === (system ?? "planning-center")
    && (j.church.church === null || (returning !== null && j.church.church === returning)));
  return { asked: runs.filter(j => !resumes(j)).length, waiting: jobs.length - runs.length };
}
/** "Your job in Keeping watch pauses" / "Your 2 jobs in Keeping watch pause", and "it" / "each one" after it. */
export const jobsPause = (jobs: number): { lead: string; one: string } =>
  jobs === 1 ? { lead: "Your job in Keeping watch pauses", one: "it" } : { lead: `Your ${jobs} jobs in Keeping watch pause`, one: "each one" };
