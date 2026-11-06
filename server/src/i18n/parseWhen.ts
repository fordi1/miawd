import { DateTime } from "luxon";
import { normalizeArabic } from "./arabic.js";

const latinDigits = (s: string) =>
  s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));

/** Number words as they look after normalizeArabic (no ال, ة→ه). */
const NUMBER_WORDS = new Map<string, number>([
  ["واحد", 1], ["واحده", 1], ["وحده", 1],
  ["ثنتين", 2], ["اثنين", 2], ["اتنين", 2], ["ثنين", 2], ["ثنتان", 2],
  ["ثلاثه", 3], ["تلاته", 3], ["ثلاث", 3], ["تلات", 3],
  ["اربعه", 4], ["اربع", 4],
  ["خمسه", 5], ["خمس", 5],
  ["سته", 6], ["ست", 6],
  ["سبعه", 7], ["سبع", 7],
  ["ثمانيه", 8], ["تمانيه", 8], ["ثمان", 8], ["تمان", 8],
  ["تسعه", 9], ["تسع", 9],
  ["عشره", 10], ["عشر", 10],
  ["احدعش", 11], ["احداعش", 11],
  ["اثنعش", 12], ["اطنعش", 12], ["ثنعش", 12], ["اثناعش", 12],
]);

const MORNING = new Set(["صبح", "صباح", "صباحا"]);
const NOON = new Set(["ظهر", "ظهرا"]);
const AFTERNOON_EVENING = new Set(["عصر", "مسا", "مساء", "مساءا"]);
const NIGHT = new Set(["ليل", "بالليل"]);

type Part = "am" | "pm" | "noon" | "night";

/**
 * Understands a time the way a customer writes it: "17:00", "5", "٥", "5 المسا", "ع الخمسة", "5 ونص",
 * "6 إلا ربع", "5pm". A bare hour 1–7 means afternoon, 8–11 morning; hours 13–23 are taken as written.
 */
export function parseTimeText(raw: string): { hour: number; minute: number } | null {
  const text = latinDigits(raw).toLowerCase().trim();
  if (!text) return null;

  let hour: number | null = null;
  let minute: number | null = null;
  let part: Part | null = null;
  let rest = text;

  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(text);
  if (m) {
    hour = Number(m[1]);
    if (m[2] !== undefined) minute = Number(m[2]);
    if (m[3]) part = m[3] as "am" | "pm";
    rest = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
  }

  const words = normalizeArabic(rest).split(" ").filter(Boolean);
  if (hour === null) {
    const word = words.find((w) => NUMBER_WORDS.has(w));
    if (!word) return null;
    hour = NUMBER_WORDS.get(word)!;
  }

  let minusQuarter = false;
  if (minute === null) {
    if (words.includes("الا") && words.includes("ربع")) {
      minusQuarter = true;
      minute = 0;
    } else if (words.includes("ونص") || words.includes("نص")) minute = 30;
    else if (words.includes("وربع") || words.includes("ربع")) minute = 15;
    else minute = 0;
  }

  if (!part) {
    for (const w of words) {
      if (MORNING.has(w)) part = "am";
      else if (NOON.has(w)) part = "noon";
      else if (AFTERNOON_EVENING.has(w)) part = "pm";
      else if (NIGHT.has(w)) part = "night";
    }
  }

  if (hour > 23 || minute > 59) return null;
  let h = hour;
  if (hour >= 1 && hour <= 12) {
    if (part === "am") h = hour === 12 ? 0 : hour;
    else if (part === "pm") h = hour === 12 ? 12 : hour + 12;
    else if (part === "noon") h = hour >= 10 ? hour : hour + 12;
    else if (part === "night") h = hour === 12 ? 0 : hour >= 6 ? hour + 12 : hour;
    else h = hour <= 7 ? hour + 12 : hour;
  }
  if (minusQuarter) return { hour: (h + 23) % 24, minute: 45 };
  return { hour: h, minute };
}

const DAY_WORDS = new Map<string, number>([
  ["يوم", 0], ["today", 0], // "اليوم" normalizes to "يوم"
  ["بكرا", 1], ["بكره", 1], ["غدا", 1], ["tomorrow", 1],
  ["بعد بكرا", 2], ["بعد بكره", 2], ["بعد غد", 2], ["بعد غدا", 2], ["day after tomorrow", 2],
]);

/** "2026-11-08" (any digits), اليوم, بكرا, بعد بكرا, today, tomorrow → yyyy-MM-dd, or null. */
export function parseDateText(raw: string, todayLocalDate: string): string | null {
  const text = latinDigits(raw).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return DateTime.fromISO(text, { zone: "utc" }).isValid ? text : null;
  const offset = DAY_WORDS.get(normalizeArabic(text));
  if (offset === undefined) return null;
  return DateTime.fromISO(todayLocalDate, { zone: "utc" }).plus({ days: offset }).toISODate();
}
