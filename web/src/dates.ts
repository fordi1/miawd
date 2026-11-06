import type { Lang } from "./i18n";

/** Dates in the UI are "yyyy-MM-dd" strings in the business's time zone; arithmetic on them is done as UTC midnight (no DST in the way). */
const MS = 86_400_000;
const utc = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (ymd: string, n: number) => fromUtc(utc(ymd) + n * MS);
/** 0 = Sunday … 6 = Saturday */
export const weekdayOf = (ymd: string) => new Date(utc(ymd)).getUTCDay();
/** The week shown starts on Saturday (Jordan's week). */
export const weekStart = (ymd: string) => addDays(ymd, -((weekdayOf(ymd) + 1) % 7));
export const monthStart = (ymd: string) => ymd.slice(0, 8) + "01";
export const addMonths = (ymd: string, n: number) => {
  const d = new Date(utc(monthStart(ymd)));
  d.setUTCMonth(d.getUTCMonth() + n);
  return fromUtc(d.getTime());
};
export const daysInMonth = (ymd: string) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7), 0)).getUTCDate();

/** The weeks (Saturday first) that cover the month of `ymd`. */
export function monthGrid(ymd: string): string[][] {
  const first = monthStart(ymd);
  const last = addDays(first, daysInMonth(first) - 1);
  const weeks: string[][] = [];
  for (let d = weekStart(first); d <= last; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  return weeks;
}

export const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

/** The local date and time of an instant in a time zone. */
export function localParts(iso: string, tz: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: +get("hour") % 24, minute: +get("minute") };
}

const locale = (lang: Lang) => (lang === "ar" ? "ar-JO-u-nu-latn" : "en-GB");

/** "9:30 ص" / "9:30 am" */
export function clock(hour: number, minute: number, lang: Lang): string {
  const h12 = ((hour + 11) % 12) + 1;
  const mm = String(minute).padStart(2, "0");
  const suffix = lang === "ar" ? (hour < 12 ? "ص" : "م") : hour < 12 ? "am" : "pm";
  return `${h12}:${mm} ${suffix}`;
}
export const timeOf = (iso: string, tz: string, lang: Lang) => {
  const p = localParts(iso, tz);
  return clock(p.hour, p.minute, lang);
};

const fmt = (lang: Lang, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale(lang), { ...options, timeZone: "UTC" });
export const weekdayName = (ymd: string, lang: Lang, style: "long" | "short" = "long") => fmt(lang, { weekday: style }).format(new Date(utc(ymd)));
export const dayMonth = (ymd: string, lang: Lang) => fmt(lang, { day: "numeric", month: "long" }).format(new Date(utc(ymd)));
export const fullDate = (ymd: string, lang: Lang) => fmt(lang, { weekday: "long", day: "numeric", month: "long" }).format(new Date(utc(ymd)));
export const monthTitle = (ymd: string, lang: Lang) => fmt(lang, { month: "long", year: "numeric" }).format(new Date(utc(ymd)));
export const dayNumber = (ymd: string) => String(+ymd.slice(8, 10));

/** Minutes since local midnight. */
export const minutesOf = (p: { hour: number; minute: number }) => p.hour * 60 + p.minute;
