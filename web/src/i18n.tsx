import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "ar" | "en";

/** Every text on screen: key -> [Jordanian Arabic, English]. `{name}` parts are filled in by t(key, { name }). */
const S: Record<string, [string, string]> = {
  // general
  "app.name": ["موعد", "Mawid"],
  "common.save": ["حفظ", "Save"],
  "common.cancel": ["إلغاء", "Cancel"],
  "common.close": ["إغلاق", "Close"],
  "common.edit": ["تعديل", "Edit"],
  "common.add": ["إضافة", "Add"],
  "common.delete": ["حذف", "Delete"],
  "common.back": ["رجوع", "Back"],
  "common.yes": ["نعم", "Yes"],
  "common.no": ["لا", "No"],
  "common.loading": ["جاري التحميل…", "Loading…"],
  "common.none": ["لا يوجد", "None"],
  "common.all": ["الكل", "All"],
  "common.search": ["دوّر…", "Search…"],
  "common.copy": ["نسخ", "Copy"],
  "common.copied": ["تم النسخ", "Copied"],
  "common.active": ["فعّال", "Active"],
  "common.inactive": ["موقوف", "Switched off"],
  "common.showInactive": ["أظهر الموقوف", "Show switched-off"],
  "common.language": ["اللغة", "Language"],
  "common.today": ["اليوم", "Today"],
  "common.optional": ["اختياري", "optional"],
  "common.name_ar": ["الاسم بالعربي", "Name (Arabic)"],
  "common.name_en": ["الاسم بالإنجليزي", "Name (English)"],
  "common.phone": ["رقم الموبايل", "Mobile number"],
  "common.reason": ["السبب", "Reason"],
  "common.minutes": ["دقيقة", "min"],
  "common.jod": ["دينار", "JD"],
  "common.logout": ["تسجيل خروج", "Log out"],
  "common.signin": ["تسجيل دخول", "Sign in"],
  "common.username": ["اسم المستخدم", "Username"],
  "common.password": ["كلمة السر", "Password"],
  "common.saved": ["تم الحفظ ✅", "Saved ✅"],
  "common.confirmDelete": ["متأكد؟", "Are you sure?"],

  // errors (by error.code)
  "err.NETWORK": ["ما في اتصال بالسيرفر، جرّب كمان مرة.", "Cannot reach the server, try again."],
  "err.INVALID_CREDENTIALS": ["اسم المستخدم أو كلمة السر غلط.", "Wrong username or password."],
  "err.ACCOUNT_DISABLED": ["هالحساب موقوف. تواصل مع الإدارة.", "This account is switched off. Contact the platform admin."],
  "err.RATE_LIMITED": ["محاولات كتير، استنى شوي وجرّب.", "Too many attempts, wait a moment and try again."],
  "err.UNAUTHORIZED": ["لازم تسجّل دخول.", "Please sign in."],
  "err.FORBIDDEN": ["ما معك صلاحية لهالإجراء.", "You are not allowed to do this."],
  "err.INVALID_INPUT": ["في معلومة ناقصة أو مش صحيحة.", "Something is missing or not valid."],
  "err.INVALID_PHONE": ["الرقم مش واضح. اكتبه بالشكل 07XXXXXXXX.", "Not a valid Jordanian mobile number (07XXXXXXXX)."],
  "err.NOT_FOUND": ["ما لقيت هالشي.", "Not found."],
  "err.SLOT_TAKEN": ["هالوقت انحجز قبل شوي. اختار وقت ثاني.", "That time was just taken. Choose another."],
  "err.HAS_UPCOMING_BOOKINGS": ["لسا في حجوزات جاية مرتبطة فيه. انقلها أو ألغيها أول.", "It still has upcoming bookings. Move or cancel them first."],
  "err.INVALID_TRANSITION": ["الحجز بحالته الحالية ما بسمح بهالإجراء.", "The booking's status does not allow this."],
  "err.SERVICE_NOT_FOUND": ["الخدمة مش موجودة.", "Service not found."],
  "err.SERVER_ERROR": ["صار خلل بسيط عنا، جرّب كمان مرة.", "Something went wrong on our side, try again."],
  "err.PASSWORD_CHANGE_REQUIRED": ["لازم تغيّر كلمة السر المؤقتة أول.", "Change the temporary password first."],

  // booking status
  "status.confirmed": ["مؤكد", "Confirmed"],
  "status.completed": ["منتهي", "Completed"],
  "status.cancelled": ["ملغي", "Cancelled"],
  "status.no_show": ["ما حضر", "No-show"],
  "status.now": ["هلأ", "Now"],

  // business panel: nav
  "nav.calendar": ["التقويم", "Calendar"],
  "nav.team": ["الفريق", "Team"],
  "nav.services": ["الخدمات", "Services"],
  "nav.zones": ["المناطق", "Zones"],
  "nav.daysOff": ["الإجازات", "Days off"],
  "nav.settings": ["الإعدادات", "Settings"],
  "nav.more": ["المزيد", "More"],

  // calendar
  "cal.day": ["يوم", "Day"],
  "cal.week": ["أسبوع", "Week"],
  "cal.month": ["شهر", "Month"],
  "cal.newBooking": ["حجز جديد", "New booking"],
  "cal.searchPlaceholder": ["دوّر برقم الزبون أو رقم الطلب…", "Find by phone or reference…"],
  "cal.summary": ["ملخص اليوم", "Day summary"],
  "cal.agenda": ["مواعيد اليوم", "Day's visits"],
  "cal.nothing": ["ما في حجوزات", "No bookings"],
  "cal.free": ["فاضي", "Free"],
  "cal.dayOff": ["إجازة", "Day off"],
  "cal.available": ["متاح", "Available"],
  "cal.results": ["نتائج البحث", "Search results"],
  "cal.noResults": ["ما لقيت أي حجز.", "No bookings found."],
  "cal.prev": ["السابق", "Previous"],
  "cal.next": ["التالي", "Next"],

  // booking drawer
  "bk.title": ["تفاصيل الحجز", "Booking details"],
  "bk.customer": ["الزبون", "Customer"],
  "bk.when": ["الموعد", "When"],
  "bk.service": ["الخدمة", "Service"],
  "bk.zone": ["المنطقة", "Zone"],
  "bk.staff": ["الفني / الموظف", "Staff member"],
  "bk.fee": ["رسوم الزيارة", "Visit fee"],
  "bk.address": ["العنوان", "Address"],
  "bk.description": ["التفاصيل", "Details"],
  "bk.ref": ["رقم الطلب", "Reference"],
  "bk.source": ["مصدر الحجز", "Made by"],
  "bk.source.api": ["البوت", "The bot"],
  "bk.source.panel": ["اللوحة", "The panel"],
  "bk.history": ["السجل", "History"],
  "bk.move": ["تأجيل / نقل", "Move"],
  "bk.cancelBooking": ["إلغاء الحجز", "Cancel booking"],
  "bk.complete": ["تمت الزيارة", "Mark completed"],
  "bk.noShow": ["ما حضر", "Mark no-show"],
  "bk.assign": ["تحويل لـ", "Assign to"],
  "bk.cancelReason": ["سبب الإلغاء (اختياري)", "Reason for cancelling (optional)"],
  "bk.confirmCancel": ["تأكيد الإلغاء", "Confirm cancellation"],
  "bk.pickTime": ["اختار الوقت الجديد", "Pick the new time"],
  "bk.noTimes": ["ما في أوقات فاضية بهالأيام.", "No free times in these days."],
  "bk.moved": ["تم نقل الحجز ✅", "Booking moved ✅"],
  "bk.cancelled": ["تم إلغاء الحجز", "Booking cancelled"],
  "bk.updated": ["تم التحديث ✅", "Updated ✅"],
  "bk.created": ["تم إنشاء الحجز ✅", "Booking created ✅"],
  "bk.call": ["اتصال", "Call"],
  "hist.created": ["تم إنشاء الحجز", "Created"],
  "hist.rescheduled": ["تم نقل الموعد", "Moved"],
  "hist.updated": ["تم تعديل البيانات", "Details edited"],
  "hist.cancelled": ["تم الإلغاء", "Cancelled"],
  "hist.status_changed": ["تغيّرت الحالة", "Status changed"],
  "by.api": ["البوت", "the bot"],
  "by.business": ["صاحب المحل", "the business"],
  "by.admin": ["إدارة المنصة", "the platform admin"],

  // new booking
  "nb.title": ["حجز جديد", "New booking"],
  "nb.service": ["الخدمة", "Service"],
  "nb.zone": ["المنطقة", "Zone"],
  "nb.date": ["التاريخ", "Date"],
  "nb.times": ["الأوقات الفاضية", "Free times"],
  "nb.name": ["اسم الزبون", "Customer name"],
  "nb.details": ["تفاصيل (مثلاً: ثلاجة LG ما بتبرد)", "Details (e.g. LG fridge not cooling)"],
  "nb.address": ["العنوان", "Address"],
  "nb.ref": ["رقم الطلب (اختياري)", "Reference (optional)"],
  "nb.pickService": ["اختار الخدمة", "Choose a service"],
  "nb.pickTime": ["اختار وقت", "Choose a time"],
  "nb.create": ["تثبيت الحجز", "Create booking"],
  "nb.anyZone": ["بدون منطقة", "No zone"],

  // search / edit
  "edit.title": ["تعديل بيانات الحجز", "Edit booking details"],

  // team
  "team.title": ["الفريق", "Team"],
  "team.add": ["إضافة موظف", "Add a staff member"],
  "team.edit": ["تعديل الموظف", "Edit staff member"],
  "team.color": ["اللون", "Colour"],
  "team.services": ["الخدمات اللي بعملها", "Services they do"],
  "team.zones": ["المناطق اللي بغطيها", "Zones they cover"],
  "team.hours": ["ساعات الدوام", "Working hours"],
  "team.dayOff": ["مجازي", "Off"],
  "team.addInterval": ["إضافة فترة", "Add a shift"],
  "team.noServices": ["ما في خدمات. أضف خدمة أول.", "No services yet. Add a service first."],
  "team.deactivate": ["إيقاف الموظف", "Switch off"],
  "team.activate": ["إعادة تفعيل", "Switch on"],
  "team.hoursSummary": ["{days} أيام", "{days} days"],
  "wd.0": ["الأحد", "Sunday"],
  "wd.1": ["الاثنين", "Monday"],
  "wd.2": ["الثلاثاء", "Tuesday"],
  "wd.3": ["الأربعاء", "Wednesday"],
  "wd.4": ["الخميس", "Thursday"],
  "wd.5": ["الجمعة", "Friday"],
  "wd.6": ["السبت", "Saturday"],

  // services & zones
  "svc.title": ["الخدمات", "Services"],
  "svc.add": ["إضافة خدمة", "Add a service"],
  "svc.edit": ["تعديل الخدمة", "Edit service"],
  "svc.duration": ["مدة الزيارة (بالدقايق)", "Duration (minutes)"],
  "svc.aliases": ["أسماء ثانية بيستعملها الزبائن (افصل بفاصلة)", "Other names customers use (comma separated)"],
  "zone.title": ["المناطق", "Zones"],
  "zone.add": ["إضافة منطقة", "Add a zone"],
  "zone.edit": ["تعديل المنطقة", "Edit zone"],
  "zone.fee": ["رسوم الزيارة (دينار)", "Visit fee (JD)"],
  "zone.noneForClinic": ["هالمحل ما بروح للزبون، فما في مناطق.", "This business does not go to customers, so it has no zones."],

  // days off
  "off.title": ["الإجازات والعطل", "Days off and holidays"],
  "off.add": ["إضافة إجازة", "Add days off"],
  "off.who": ["لمين؟", "For whom?"],
  "off.everyone": ["كل المحل", "The whole business"],
  "off.from": ["من تاريخ", "From"],
  "off.to": ["لحد تاريخ (شامل)", "To (inclusive)"],
  "off.reason": ["السبب (مثلاً: عيد)", "Reason (e.g. Eid)"],
  "off.none": ["ما في إجازات جاية.", "No upcoming days off."],
  "off.note": ["الحجوزات الموجودة ما بتتغيّر؛ بس الأوقات الجديدة ما بتنعرض.", "Existing bookings are not changed; new times just stop being offered."],

  // settings
  "set.title": ["الإعدادات", "Settings"],
  "set.rules": ["قواعد الحجز", "Booking rules"],
  "set.slot_step_min": ["الأوقات كل (دقيقة)", "Offer times every (minutes)"],
  "set.gap_min": ["فاصل بين الحجوزات (دقيقة)", "Gap between bookings (minutes)"],
  "set.min_lead_min": ["أقرب حجز بعد (دقيقة)", "Earliest booking from now (minutes)"],
  "set.horizon_days": ["أبعد حجز (أيام)", "Furthest booking (days ahead)"],
  "set.change_cutoff_min": ["البوت بغيّر/يلغي لحد (دقيقة قبل الموعد)", "The bot may change/cancel until (minutes before)"],
  "set.display_digits": ["الأرقام بنصوص البوت", "Digits in the bot's texts"],
  "set.digits.latin": ["1 2 3", "1 2 3"],
  "set.digits.arabic": ["١ ٢ ٣", "١ ٢ ٣"],
  "set.password": ["تغيير كلمة السر", "Change password"],
  "set.currentPassword": ["كلمة السر الحالية", "Current password"],
  "set.newPassword": ["كلمة السر الجديدة (8 أحرف على الأقل)", "New password (at least 8 characters)"],
  "set.passwordChanged": ["تم تغيير كلمة السر ✅", "Password changed ✅"],
  "set.mustChange": ["هاي كلمة سر مؤقتة. اختار كلمة سر جديدة عشان تكمّل.", "This is a temporary password. Choose a new one to continue."],
  "set.byAdmin": ["إنت فاتح لوحة هالمحل كإدارة. كل التغييرات بتنسجّل باسم الإدارة.", "You opened this business's panel as the platform admin. Every change is recorded as made by the admin."],
  "set.backToAdmin": ["رجوع للإدارة", "Back to admin"],

  // admin panel
  "adm.title": ["إدارة المنصة", "Platform admin"],
  "adm.dashboard": ["الرئيسية", "Dashboard"],
  "adm.businesses": ["المحلات", "Businesses"],
  "adm.month": ["الشهر", "Month"],
  "adm.businessesTotal": ["عدد المحلات", "Businesses"],
  "adm.bookingsTotal": ["الحجوزات", "Bookings"],
  "adm.perBusiness": ["لكل محل", "Per business"],
  "adm.madeIn": ["الحجوزات اللي انعملت بهالشهر", "Bookings made this month"],
  "adm.test": ["تجريبي", "Test"],
  "adm.addBusiness": ["إضافة محل", "Add a business"],
  "adm.businessName": ["اسم المحل", "Business name"],
  "adm.initialPassword": ["كلمة سر مؤقتة (8 أحرف على الأقل)", "Temporary password (at least 8 characters)"],
  "adm.goesToCustomer": ["بروح لعند الزبون (مناطق ورسوم زيارة)", "Goes to the customer (zones and visit fees)"],
  "adm.isTest": ["محل تجريبي (بيجي مع بيانات نمونة)", "Test business (comes with sample data)"],
  "adm.staffLabelAr": ["اسم الموظف بالعربي (مثلاً: فني)", "What staff are called (Arabic, e.g. فني)"],
  "adm.staffLabelEn": ["اسم الموظف بالإنجليزي", "What staff are called (English)"],
  "adm.created": ["تم إنشاء المحل", "Business created"],
  "adm.keyOnce": ["هاد مفتاح الـ API. بينعرض مرة وحدة بس — انسخه هلأ.", "This is the API key. It is shown only once — copy it now."],
  "adm.apiAccess": ["الوصول للـ API", "API access"],
  "adm.endpoint": ["الرابط (Endpoint)", "Endpoint"],
  "adm.apiKey": ["مفتاح الـ API", "API key"],
  "adm.regenerate": ["مفتاح جديد", "New key"],
  "adm.regenerateWarn": ["المفتاح القديم رح يوقف فوراً. كمّل؟", "The old key stops working immediately. Continue?"],
  "adm.newKey": ["المفتاح الجديد", "The new key"],
  "adm.webhook": ["Webhook", "Webhook"],
  "adm.webhookUrl": ["رابط الـ Webhook (https)", "Webhook URL (https)"],
  "adm.webhookSecret": ["السر (للتحقق من التوقيع)", "Secret (to verify signatures)"],
  "adm.owner": ["حساب صاحب المحل", "Owner login"],
  "adm.resetPassword": ["كلمة سر مؤقتة جديدة", "New temporary password"],
  "adm.resetPasswordDone": ["تم. صاحب المحل لازم يغيّرها أول ما يدخل.", "Done. The owner must change it at the next login."],
  "adm.openCalendar": ["فتح التقويم", "Open calendar"],
  "adm.docs": ["دليل الربط بالـ API", "API integration guide"],
  "adm.resetTest": ["إعادة تعيين البيانات التجريبية", "Reset test data"],
  "adm.resetTestWarn": ["رح تنمسح كل الحجوزات والإعدادات وتنرجع بيانات النمونة. كمّل؟", "All bookings and setup are wiped and the sample data comes back. Continue?"],
  "adm.switchOff": ["إيقاف المحل", "Switch off"],
  "adm.switchOn": ["إعادة تفعيل", "Switch on"],
  "adm.dangerZone": ["منطقة خطر", "Danger zone"],
  "adm.deleteBusiness": ["حذف المحل نهائياً", "Delete the business for good"],
  "adm.deleteWarn": ["بينحذف المحل وكل حجوزاته وإعداداته. اكتب اسم المحل بالضبط للتأكيد:", "The business and all its bookings and setup are deleted. Type the business name exactly to confirm:"],
  "adm.status": ["الحالة", "Status"],
  "adm.createdAt": ["تاريخ الإنشاء", "Created"],
  "adm.username": ["اسم المستخدم", "Username"],
};

type Vars = Record<string, string | number>;
interface I18n {
  lang: Lang;
  dir: "rtl" | "ltr";
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Vars) => string;
  /** The text for an error code, falling back to the server's English message. */
  err: (e: { code?: string; message?: string }) => string;
}

const Ctx = createContext<I18n | null>(null);

const readLang = (): Lang => {
  try {
    const saved = localStorage.getItem("mawid_lang");
    if (saved === "ar" || saved === "en") return saved;
  } catch {
    /* storage can be blocked */
  }
  return "ar";
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang);
  const dir = lang === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("mawid_lang", l);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<I18n>(() => {
    const t = (key: string, vars?: Vars) => {
      const entry = S[key];
      let text = entry ? entry[lang === "ar" ? 0 : 1] : key;
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
      return text;
    };
    const err = (e: { code?: string; message?: string }) => (e.code && S[`err.${e.code}`] ? t(`err.${e.code}`) : e.message || t("err.SERVER_ERROR"));
    return { lang, dir, setLang, t, err };
  }, [lang, dir, setLang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}
