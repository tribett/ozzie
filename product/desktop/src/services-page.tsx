// The Services page when Ozzie watches more than one service (owner decision 2026-11-19: "some churches have multiple
// services and we need to account for that"): the page's question once, how many things need a decision across all of
// them (the same count as the sidebar and Today), one Check now for every service, then each service in date order, each
// headed by its own name with its date, times and findings (sunday-page.tsx `part`). Names are Planning Center's own
// service names and people's names resolve on this Mac only, as on the one-service page.
import type { ReactNode } from "react";
import { SERVICES_QUESTION } from "../../../core/src/service-day.js";

const andList = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
const things = (n: number) => n === 1 ? "1 thing needs" : `${n} things need`;
/** "3 things need a decision across 2 services, and 1 is worth a look." Counts of items, never of people. */
export function acrossText(c: { decisions: number; looks: number }, services: number): string {
  const lead = c.decisions ? `${things(c.decisions)} a decision across ${services} services` : `Nothing needs a decision across ${services} services`;
  return `${lead}${c.looks ? `, and ${c.looks} ${c.looks === 1 ? "is" : "are"} worth a look` : ""}.`;
}

/** One watched service's part of the page: its date to order by ("YYYY-MM-DD", null when not known), its day as said, and the part itself. */
export interface ServicePart { key: string; date: string | null; dayText: string | null; node: ReactNode }

/** Earliest first; a service whose date isn't known yet after the rest, in the order they were added. */
export const inDateOrder = <T extends Pick<ServicePart, "date">>(parts: readonly T[]): T[] =>
  parts.map((p, i) => ({ p, i })).sort((a, b) => a.p.date && b.p.date ? a.p.date.localeCompare(b.p.date) || a.i - b.i : a.p.date ? -1 : b.p.date ? 1 : a.i - b.i).map(x => x.p);

export function ServicesPage({ parts, counts, controls, watch }: {
  parts: readonly ServicePart[];
  /** The page's count across every service (App's: the same as the sidebar and Today). Null before any check. */
  counts: { decisions: number; looks: number } | null;
  /**
   * What the check is and what can be done with it, once for every service (sunday-page.tsx PageControls): the live read
   * and when it was checked, Check now, the last saved check, connecting or checking, and why a check failed.
   */
  controls: ReactNode;
  /** Which services Ozzie watches, and Watch another service (watch-another.tsx). */
  watch?: ReactNode;
}) {
  const ordered = inDateOrder(parts);
  const days = [...new Set(ordered.flatMap(p => p.dayText ? [p.dayText] : []))];
  return <div className="col services">
    {days.length > 0 && <p className="eyebrow">{andList(days)}</p>}
    <h1 className="h1">{SERVICES_QUESTION}</h1>
    {counts && <p className="lede">{acrossText(counts, parts.length)}</p>}
    {controls}
    {ordered.map(p => <div key={p.key} className="service-part-wrap">{p.node}</div>)}
    {watch && <section className="stack" aria-labelledby="services-watch-title">
      <h2 id="services-watch-title" className="h3">Which services Ozzie watches</h2>
      {watch}
    </section>}
  </div>;
}
