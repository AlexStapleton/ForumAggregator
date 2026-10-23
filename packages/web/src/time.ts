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

/** A podcast's length for a card: "45 min", "1 h 05 min", "50 s". */
export function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** A position in an episode: "4:07", "1:02:03". */
export function clockLabel(seconds: number): string {
  const s = Math.floor(seconds);
  const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  return hms[0] ? `${hms[0]}:${String(hms[1]).padStart(2, "0")}:${String(hms[2]).padStart(2, "0")}` : `${hms[1]}:${String(hms[2]).padStart(2, "0")}`;
}
