// What the pages show for a church on B1 Church or Breeze where Planning Center's own parts don't apply: the facts
// beside the service's findings (a plan not shared yet, people with no role, the time zone question, no roles at all).
// Plain and exact: never a promise a system can't keep. Keeping watch is Planning Center's own page (proactive-page.tsx).
import { noRoles } from "../../../core/src/church-systems/facts.js";
import type { CoverageRefusal } from "../../../core/src/church-systems/coverage.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import type { OtherSystem, SystemConnection } from "./church-system.js";
import { SYSTEMS } from "../../../core/src/church-systems/types.js";
import { TimeZoneQuestion } from "./system-setup.js";
import { Icon } from "./icons.js";

/**
 * Why a check of the watched service built no service check, in one plain line (final review M1): no roles planned, or
 * the service's own times couldn't be read. null when it built one.
 */
export function refusalLine(system: OtherSystem, refusal: CoverageRefusal | null): string | null {
  const name = SYSTEMS[system].name;
  if (refusal === "no-roles") return `${noRoles(system).join(" ")} There is nothing for Ozzie to check for this one yet; you can choose a different one in Settings.`;
  if (refusal === "no-service") return `Ozzie couldn't read this service's times from ${name}, so it couldn't check it. Check ${name} again in a moment; What happened lists which read didn't finish.`;
  if (refusal) return `${name} gave no service Ozzie can check here.`;
  return null;
}

/** The facts beside a system's findings on the service's page, the zone question while the check waits for it. */
export function SystemNotices({ connection, capture, notices, waitingForZone, refusal, onZone }: {
  connection: SystemConnection; capture: SystemCapture | null; notices: readonly string[]; waitingForZone: boolean;
  refusal: CoverageRefusal | null; onZone: (zone: string) => void;
}) {
  return <>
    {waitingForZone && capture && <section className="find" aria-labelledby="system-zone-q">
      <div className="find-top"><span className="badge b-look"><Icon name="eye" small />Worth a look</span></div>
      <h3 id="system-zone-q" className="find-title">Which time zone does your church meet in?</h3>
      <TimeZoneQuestion system={connection.system} systemZone={capture.church.time_zone} startsAt={capture.service?.starts_at ?? null} initial={connection.zone} onConfirm={onZone} />
    </section>}
    {refusal === "no-roles" && noRoles(connection.system).map(line => <p key={line} className="lede">{line}</p>)}
    {notices.map(line => <p key={line} className="banner"><Icon name="info" small /><span>{line}</span></p>)}
  </>;
}

