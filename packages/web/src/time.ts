const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

/** "5 min. ago", "in 25 min.", "yesterday". */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = (ts - now) / 1000;
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return Math.abs(diff) < 45 ? "just now" : rtf.format(Math.round(diff / 60), "minute");
}

export function fullDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Heading for a day in the timeline: "Today", "Yesterday", "Monday 14 October" (with the year if not this year). */
export function dayLabel(ts: number, now = Date.now()): string {
  const day = startOfDay(ts);
  const today = startOfDay(now);
  if (day === today) return "Today";
  if (day === startOfDay(today - 12 * 3600 * 1000)) return "Yesterday";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Local midnight of the day containing ts (DST-safe: built from the calendar date, not by subtracting hours). */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
