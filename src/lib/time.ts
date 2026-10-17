/**
 * India Standard Time helpers. IST is a fixed UTC+05:30 with no daylight
 * saving, so conversion is exact arithmetic. All timestamps are stored in UTC.
 */
export const IST_OFFSET_MIN = 330;

/** UTC instant for `date` (YYYY-MM-DD, interpreted in IST) + minutes after IST midnight. */
export function istToUtc(date: string, minutesAfterMidnight: number): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 0, 0) + (minutesAfterMidnight - IST_OFFSET_MIN) * 60_000);
}

/** IST calendar date (YYYY-MM-DD) and weekday (0=Sun) for a UTC instant. */
export function utcToIstParts(at: Date): { date: string; dayOfWeek: number; minutes: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MIN * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    dayOfWeek: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** Inclusive list of IST dates between two YYYY-MM-DD strings. */
export function istDateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return out;
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function formatIst(at: Date): string {
  return at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}
