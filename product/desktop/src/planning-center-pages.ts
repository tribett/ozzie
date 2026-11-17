// "Open in Planning Center" (audit item 25): the plan the Sunday page shows, or a person on it, opened in the leader's
// own browser so they can do there what Ozzie never does. The page sends which kind of page and a Planning Center id it
// already holds from the check on screen, digits only; native code builds the address from a fixed host and path and
// opens it (src-tauri/src/planning_center_pages.rs). Nothing is read or changed: the browser shows the page as the
// leader's own Planning Center session allows.
import { invoke } from "@tauri-apps/api/core";

export type PlanningCenterPage = "plan" | "person";
/** A Planning Center id, as native code accepts one: digits, no leading zero. */
const ID = /^[1-9]\d{0,31}$/u;
export const OPEN_PLAN = "Open the plan in Planning Center";
export const OPEN_PERSON = "Open in Planning Center";
export const NOT_OPENED = "Planning Center couldn't be opened in your browser just now.";
/** Opens one page; true once the browser was asked to open it. Never throws. Anything but an id is never sent. */
export async function openInPlanningCenter(page: PlanningCenterPage, id: string): Promise<boolean> {
  if (!ID.test(id)) return false;
  try { await invoke("open_in_planning_center", { page, id }); return true; } catch { return false; }
}
