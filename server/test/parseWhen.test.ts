import { describe, expect, it } from "vitest";
import { parseDateText, parseTimeText } from "../src/i18n/parseWhen.js";

const hhmm = (t: { hour: number; minute: number } | null) =>
  t && `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;

describe("parseTimeText (what a customer writes)", () => {
  it.each([
    // 24-hour and digits in any script
    ["17:00", "17:00"],
    ["5", "17:00"],
    ["٥", "17:00"],
    ["۵", "17:00"],
    // a bare hour 1–7 means afternoon, 8–11 morning
    ["1", "13:00"],
    ["7", "19:00"],
    ["8", "08:00"],
    ["9", "09:00"],
    ["10", "10:00"],
    ["12", "12:00"],
    // Jordanian phrasing
    ["5 المسا", "17:00"],
    ["5 مساءً", "17:00"],
    ["ع الخمسة", "17:00"],
    ["على الخمسة", "17:00"],
    ["الساعة 5", "17:00"],
    ["الساعة خمسة ونص", "17:30"],
    ["10 الصبح", "10:00"],
    ["عشرة الصبح", "10:00"],
    ["1 الظهر", "13:00"],
    ["12 الظهر", "12:00"],
    ["4 العصر", "16:00"],
    ["9 بالليل", "21:00"],
    ["ثمانية", "08:00"],
    ["ثنتين", "14:00"],
    ["احدعش", "11:00"],
    // halves and quarters
    ["5 ونص", "17:30"],
    ["5:30", "17:30"],
    ["5 وربع", "17:15"],
    ["6 إلا ربع", "17:45"],
    // English
    ["5pm", "17:00"],
    ["5 PM", "17:00"],
    ["5am", "05:00"],
  ])("%s -> %s", (text, expected) => {
    expect(hhmm(parseTimeText(text))).toBe(expected);
  });

  it.each(["", "abc", "25", "5:70", "بكرا"])("does not understand %j", (text) => {
    expect(parseTimeText(text)).toBeNull();
  });
});

describe("parseDateText (today = Saturday 2026-11-07)", () => {
  const today = "2026-11-07";

  it.each([
    ["2026-11-08", "2026-11-08"],
    ["٢٠٢٦-١١-٠٨", "2026-11-08"],
    ["اليوم", "2026-11-07"],
    ["today", "2026-11-07"],
    ["بكرا", "2026-11-08"],
    ["بكره", "2026-11-08"],
    ["tomorrow", "2026-11-08"],
    ["بعد بكرا", "2026-11-09"],
    ["بعد بكره", "2026-11-09"],
  ])("%s -> %s", (text, expected) => {
    expect(parseDateText(text, today)).toBe(expected);
  });

  it.each(["", "2026-13-40", "الخميس", "xyz"])("does not understand %j", (text) => {
    expect(parseDateText(text, today)).toBeNull();
  });
});
