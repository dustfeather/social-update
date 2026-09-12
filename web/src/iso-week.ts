// ISO week label helpers. The app keys everything off strings like "2026-W37",
// which are precise but unreadable — nobody knows which days W37 covers without
// counting. These turn the key back into the dates it stands for.

const MS_PER_DAY = 86_400_000;

// Monday of the given ISO week, as a UTC date. ISO pins week 1 as the one
// containing Jan 4, so week 1's Monday is the Monday on or before Jan 4 and
// every later week is a multiple of 7 days from it. Returns null for anything
// that isn't a well-formed week key.
export function isoWeekStart(week: string): Date | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return null;
  const year = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || n > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const isoDow = jan4.getUTCDay() || 7; // getUTCDay is Sun=0; ISO wants Mon=1..Sun=7
  return new Date(Date.UTC(year, 0, 4 - (isoDow - 1)) + (n - 1) * 7 * MS_PER_DAY);
}

// Everything is formatted in UTC because the week key itself is timezone-free:
// rendering it in the viewer's zone would slide the boundary a day either way.
const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  d.toLocaleDateString("en-US", { timeZone: "UTC", ...opts });

// "Sep 7 – Sep 13" for a week key, or "" when the key is unusable — the caller
// renders this inline next to a count, so an empty string degrades quietly
// rather than printing "Invalid Date".
export function isoWeekRange(week: string): string {
  const start = isoWeekStart(week);
  if (!start) return "";
  const end = new Date(start.getTime() + 6 * MS_PER_DAY);
  // A week can straddle New Year (W01, W52/W53), and then the bare month/day is
  // ambiguous — spell the year out on both ends in that case only.
  const spanned = start.getUTCFullYear() !== end.getUTCFullYear();
  const opts: Intl.DateTimeFormatOptions = spanned
    ? { month: "short", day: "numeric", year: "numeric" }
    : { month: "short", day: "numeric" };
  return `${fmt(start, opts)} – ${fmt(end, opts)}`;
}
