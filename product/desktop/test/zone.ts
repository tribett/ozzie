// Which clock "this Mac" is on, for a test: the process's time zone (process.env.TZ), set for one piece of work and put
// back after it. Node takes a new TZ at once, for Date and Intl alike; vitest runs one file's tests one at a time, so
// nothing else in the file sees it. A run with TZ=UTC (as CI is) is put back to UTC.
import { afterAll, beforeAll } from "vitest";

const macZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Puts this process on `zone` and gives back how to put it back. */
function setZone(zone: string): () => void {
  const was = process.env.TZ;
  process.env.TZ = zone;
  const back = () => { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; };
  if (macZone() !== zone) { back(); throw new Error(`This process didn't take the time zone ${zone} (it reads ${macZone()}).`); }
  return back;
}

/** `work` with this process on `zone`; the zone it was on before is put back, whatever `work` does. */
export function inZone<T>(zone: string, work: () => T): T {
  const back = setZone(zone);
  try { return work(); } finally { back(); }
}

/** As inZone, for work that awaits (a page mounted and pressed). */
export async function inZoneAsync<T>(zone: string, work: () => Promise<T>): Promise<T> {
  const back = setZone(zone);
  try { return await work(); } finally { back(); }
}

/** Every test of the enclosing describe with this process on `zone`, put back after the last of them. */
export function onZone(zone: string): void {
  let back: (() => void) | null = null;
  beforeAll(() => { back = setZone(zone); });
  afterAll(() => { back?.(); back = null; });
}
