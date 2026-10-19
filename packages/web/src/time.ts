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
