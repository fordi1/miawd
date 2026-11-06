import { describe, expect, it } from "vitest";
import { applyDigits, dayPhraseAr, fullDateAr, normalizeArabic, timePhraseAr } from "../src/i18n/arabic.js";
import { normalizeJordanMobile } from "../src/lib/phone.js";

describe("normalizeArabic (matching names the way customers type them)", () => {
  it("ignores ال, hamza forms, ة/ه, ى/ي, tashkeel and punctuation", () => {
    expect(normalizeArabic("الهاشمي الشمالي")).toBe(normalizeArabic("هاشمي شمالي"));
    expect(normalizeArabic("أَبو نصير")).toBe("ابو نصير");
    expect(normalizeArabic("مدينة الحسين")).toBe(normalizeArabic("مدينه حسين"));
    expect(normalizeArabic("عمّان!")).toBe("عمان");
    expect(normalizeArabic("  تلاع   العلي ")).toBe("تلاع علي");
  });

  it("does not strip ال from short words (الله)", () => {
    expect(normalizeArabic("الله")).toBe("الله");
  });

  it("turns Arabic-Indic and Persian digits into Latin digits", () => {
    expect(normalizeArabic("شارع ٥٠")).toBe("شارع 50");
    expect(normalizeArabic("شارع ۵۰")).toBe("شارع 50");
  });
});

describe("timePhraseAr (Jordanian speech)", () => {
  it.each([
    [10, 0, "الساعة 10 الصبح"],
    [10, 30, "الساعة 10 ونص الصبح"],
    [10, 15, "الساعة 10 وربع الصبح"],
    [10, 45, "الساعة 11 إلا ربع الصبح"],
    [11, 45, "الساعة 12 إلا ربع الظهر"],
    [13, 0, "الساعة 1 الظهر"],
    [16, 0, "الساعة 4 العصر"],
    [19, 0, "الساعة 7 المسا"],
    [10, 10, "الساعة 10:10 الصبح"],
    [0, 0, "الساعة 12 بالليل"],
  ])("%i:%i -> %s", (h, m, expected) => {
    expect(timePhraseAr(h, m)).toBe(expected);
  });
});

describe("dates in Arabic (2026-11-01 is a Sunday)", () => {
  it("says اليوم / بكرا / بعد بكرا, then the full date", () => {
    expect(dayPhraseAr("2026-11-01", "2026-11-01")).toBe("اليوم الأحد");
    expect(dayPhraseAr("2026-11-02", "2026-11-01")).toBe("بكرا الاثنين");
    expect(dayPhraseAr("2026-11-03", "2026-11-01")).toBe("بعد بكرا الثلاثاء");
    expect(dayPhraseAr("2026-11-04", "2026-11-01")).toBe("الأربعاء 4 تشرين الثاني");
  });

  it("uses Levantine month names", () => {
    expect(fullDateAr("2026-01-05")).toBe("الاثنين 5 كانون الثاني");
    expect(fullDateAr("2026-02-10")).toBe("الثلاثاء 10 شباط");
    expect(fullDateAr("2026-12-31")).toBe("الخميس 31 كانون الأول");
  });
});

describe("applyDigits", () => {
  it("keeps Latin digits by default and converts on request", () => {
    expect(applyDigits("الساعة 10", "latin")).toBe("الساعة 10");
    expect(applyDigits("الساعة 10", "arabic")).toBe("الساعة ١٠");
  });
});

describe("normalizeJordanMobile", () => {
  it.each([
    "0795550100",
    "795550100",
    "962795550100",
    "+962795550100",
    "+962 79 555 0100",
    "00962795550100",
    "+962 (0) 78 226 0535",
    "٠٧٩٥٥٥٠١٠٠", // Arabic-Indic digits
    "۰۷۸۲۲۶۰۵۳۵", // Persian digits
    "078-226-0535",
  ])("accepts %s", (raw) => {
    expect(normalizeJordanMobile(raw)).toBe("+962795550100");
  });

  it.each(["", "12345", "0612345678", "07123456789", "0722260535", "abc"])("rejects %s", (raw) => {
    expect(normalizeJordanMobile(raw)).toBeNull();
  });

  it("accepts the 77 / 79 / 75 prefixes too", () => {
    expect(normalizeJordanMobile("0791234567")).toBe("+962791234567");
    expect(normalizeJordanMobile("0771234567")).toBe("+962771234567");
    expect(normalizeJordanMobile("0751234567")).toBe("+962751234567");
  });
});
