import { DateTime } from "luxon";

/**
 * Normalizes Arabic text for matching ("الهاشمي الشمالي" == "هاشمي شمالي"): removes tashkeel/tatweel, unifies
 * hamza forms, ة→ه, ى→ي, turns Arabic-Indic / Persian digits into Latin digits, drops punctuation and the
 * definite article ال from words of 5+ letters (so "الله" is left alone).
 */
export function normalizeArabic(input: string): string {
  const s = input
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length >= 5 && w.startsWith("ال") ? w.slice(2) : w))
    .join(" ");
}

const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"]; // 0 = Sunday
const MONTHS = [
  "كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران",
  "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول",
];

const hour12 = (h: number) => ((h + 11) % 12) + 1;
function partAr(h: number): string {
  if (h < 5) return "بالليل";
  if (h < 12) return "الصبح";
  if (h < 15) return "الظهر";
  if (h < 17) return "العصر"; // 3 and 4 pm; from 5 pm it is "المسا" (SPEC §6.8)
  return "المسا";
}

/** "الساعة 10 الصبح", "الساعة 10 ونص الصبح", "الساعة 11 إلا ربع الصبح" … */
export function timePhraseAr(hour: number, minute: number): string {
  if (minute === 0) return `الساعة ${hour12(hour)} ${partAr(hour)}`;
  if (minute === 15) return `الساعة ${hour12(hour)} وربع ${partAr(hour)}`;
  if (minute === 30) return `الساعة ${hour12(hour)} ونص ${partAr(hour)}`;
  if (minute === 45) {
    const next = (hour + 1) % 24;
    return `الساعة ${hour12(next)} إلا ربع ${partAr(next)}`;
  }
  return `الساعة ${hour12(hour)}:${String(minute).padStart(2, "0")} ${partAr(hour)}`;
}

function parseLocalDate(localDate: string) {
  return DateTime.fromISO(localDate, { zone: "utc" });
}

/** "الاثنين 2 تشرين الثاني" */
export function fullDateAr(localDate: string): string {
  const d = parseLocalDate(localDate);
  return `${WEEKDAYS[d.weekday % 7]} ${d.day} ${MONTHS[d.month - 1]}`;
}

/** "اليوم الأحد" / "بكرا الاثنين" / "بعد بكرا الثلاثاء", otherwise the full date. */
export function dayPhraseAr(localDate: string, todayLocalDate: string): string {
  const d = parseLocalDate(localDate);
  const diff = Math.round(d.diff(parseLocalDate(todayLocalDate), "days").days);
  const weekday = WEEKDAYS[d.weekday % 7];
  if (diff === 0) return `اليوم ${weekday}`;
  if (diff === 1) return `بكرا ${weekday}`;
  if (diff === 2) return `بعد بكرا ${weekday}`;
  return fullDateAr(localDate);
}

export type DigitStyle = "latin" | "arabic";

export function applyDigits(text: string, style: DigitStyle): string {
  return style === "arabic" ? text.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d))) : text;
}
