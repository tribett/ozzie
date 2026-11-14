const HOUR_MS = 3600 * 1000;

/** Urgent only when the gathering is at or within 48h AND the fact is checked and solid. */
export function isUrgent(now: Date, gathering: Date, checkedSolid = true): boolean {
  if (!checkedSolid) return false;
  const ms = gathering.getTime() - now.getTime();
  return ms >= 0 && ms <= 48 * HOUR_MS;
}

/** Quiet hours 21:00-07:00 local, evaluated on the injected clock. */
export function inQuietHours(now: Date): boolean {
  const h = now.getHours();
  return h >= 21 || h < 7;
}
