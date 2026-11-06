import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { issueApiKey } from "../src/auth/apiKey.js";
import { addStaff, addZone, seedBusiness, setDefaultHours, testPool } from "./helpers.js";

const PEPPER = "test-pepper-not-a-secret";
const SECRET = "test-slot-secret-not-a-secret";
const pool = testPool(10);

// Saturday 7 Nov 2026, 03:00 Amman → "tomorrow" is Sunday 8 Nov (a working day).
const BASE = new Date("2026-11-07T00:00:00Z");
const clock = { now: BASE };

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp(pool, { apiKeyPepper: PEPPER, slotTokenSecret: SECRET, now: () => clock.now });
});
afterEach(() => {
  clock.now = BASE;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

/** A business that goes to customers: one technician, service "صيانة ثلاجة" (alias "ثلاجة"), zone "الهاشمي الشمالي". */
async function shop() {
  const ids = await seedBusiness(pool);
  await setDefaultHours(pool, ids.staffId);
  await pool.query("UPDATE services SET aliases = ARRAY['ثلاجة', 'براد'] WHERE id = $1", [ids.serviceId]);
  const zoneId = await addZone(pool, ids.businessId, "الهاشمي الشمالي", [ids.staffId]);
  await pool.query("UPDATE zones SET visit_fee_jod = 10 WHERE id = $1", [zoneId]);
  const key = await issueApiKey(pool, ids.businessId, PEPPER);
  return { ...ids, zoneId, key };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const day = "2026-11-08"; // Sunday

async function getSlots(s: Shop, limit = 3, extra: Record<string, string> = {}) {
  const r = await app.inject({
    method: "GET",
    url: "/v1/availability",
    query: { service: "ثلاجة", zone: "هاشمي شمالي", date_from: day, date_to: day, limit: String(limit), ...extra },
    headers: auth(s.key),
  });
  return { res: r, body: r.json(), slots: r.json().data?.slots ?? [] };
}
const book = (s: Shop, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/bookings", headers: auth(s.key), payload });
const customer = { customer_name: "سامر", customer_phone: "0795550100" };

describe("authentication", () => {
  it("answers 401 with the standard envelope for missing and wrong keys", async () => {
    const none = await app.inject({ method: "GET", url: "/v1/availability?service=x" });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(none.json().request_id).toMatch(/^req_/);

    const wrong = await app.inject({ method: "GET", url: "/v1/availability?service=x", headers: auth("bk_live_nope") });
    expect(wrong.statusCode).toBe(401);
  });

  it("stops working when the key is regenerated or the business is deactivated", async () => {
    const s = await shop();
    expect((await getSlots(s)).res.statusCode).toBe(200);

    await issueApiKey(pool, s.businessId, PEPPER); // regenerate: the old key must die
    expect((await getSlots(s)).res.statusCode).toBe(401);

    const s2 = await shop();
    await pool.query("UPDATE businesses SET active = false WHERE id = $1", [s2.businessId]);
    expect((await getSlots(s2)).res.statusCode).toBe(401);
  });

  it("has an open /health endpoint", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
  });
});

describe("GET /v1/availability", () => {
  it("finds service and zone by the names a customer would type and writes the Jordanian text", async () => {
    const s = await shop();
    const { res, body, slots } = await getSlots(s);

    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.zone).toMatchObject({ name_ar: "الهاشمي الشمالي", visit_fee_jod: "10.000" });
    expect(body.data.service).toMatchObject({ name_ar: "صيانة ثلاجة", duration_min: 60 });
    expect(slots.map((x: { local_time: string }) => x.local_time)).toEqual(["09:00", "12:00", "14:00"]);
    expect(slots[0]).toMatchObject({
      start_at: "2026-11-08T06:00:00.000Z",
      end_at: "2026-11-08T07:00:00.000Z",
      local_date: "2026-11-08",
      part_of_day: "morning",
      label_ar: "الأحد 8 تشرين الثاني، الساعة 9 الصبح",
    });
    expect(slots[0].slot_token).toMatch(/^st_/);
    expect(body.display_ar).toBe(
      "عنا مواعيد فاضية:\n1) بكرا الأحد الساعة 9 الصبح\n2) بكرا الأحد الساعة 12 الظهر\n3) بكرا الأحد الساعة 2 الظهر\nأي موعد بناسبك؟",
    );
  });

  it("can write digits as Arabic-Indic when the business wants it", async () => {
    const s = await shop();
    await pool.query(`UPDATE businesses SET settings = settings || '{"display_digits":"arabic"}' WHERE id = $1`, [s.businessId]);
    const { body } = await getSlots(s, 1);
    expect(body.display_ar).toContain("بكرا الأحد الساعة ٩ الصبح");
  });

  it("is not an error when nothing is free", async () => {
    const s = await shop();
    const r = await app.inject({
      method: "GET",
      url: "/v1/availability",
      query: { service: "ثلاجة", zone: "هاشمي شمالي", date_from: "2026-11-13", date_to: "2026-11-13" }, // a Friday
      headers: auth(s.key),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.slots).toEqual([]);
    expect(r.json().display_ar).toBe("للأسف ما في مواعيد فاضية بهالأيام، بتحب أشوفلك الأسبوع الجاي؟");
  });

  it("explains unknown service, unknown zone and an uncovered zone", async () => {
    const s = await shop();
    const noService = await getSlots(s, 3, { service: "غسالة" });
    expect(noService.res.statusCode).toBe(422);
    expect(noService.body.error.code).toBe("SERVICE_NOT_FOUND");

    const noZone = await getSlots(s, 3, { zone: "ماركا" });
    expect(noZone.res.statusCode).toBe(422);
    expect(noZone.body.error).toMatchObject({ code: "ZONE_NOT_FOUND", display_ar: "ما لقيت هالمنطقة 🤔 ممكن تكتب اسم الحي؟" });

    await addZone(pool, s.businessId, "عبدون", []); // exists, but nobody covers it
    const uncovered = await getSlots(s, 3, { zone: "عبدون" });
    expect(uncovered.res.statusCode).toBe(422);
    expect(uncovered.body.error).toMatchObject({ code: "ZONE_NOT_COVERED", display_ar: "للأسف ما منغطي هالمنطقة حالياً." });
  });

  it("never shows another business's data", async () => {
    const a = await shop();
    const b = await shop();
    const { res, body } = await getSlots(b, 3, { service: a.serviceId });
    expect(res.statusCode).toBe(422);
    expect(body.error.code).toBe("SERVICE_NOT_FOUND");
  });

  it("validates dates and limit", async () => {
    const s = await shop();
    expect((await getSlots(s, 3, { date_from: "08/11/2026" })).body.error.code).toBe("INVALID_INPUT");
    expect((await getSlots(s, 50)).body.error.code).toBe("INVALID_INPUT");
    expect((await getSlots(s, 3, { date_from: "2026-11-10", date_to: "2026-11-08" })).body.error.code).toBe("INVALID_INPUT");
  });
});

describe("POST /v1/bookings", () => {
  it("books the chosen slot and answers with the confirmation text", async () => {
    const s = await shop();
    const [slot] = (await getSlots(s, 1)).slots;
    const r = await book(s, {
      slot_token: slot.slot_token,
      ...customer,
      description: "ثلاجة LG — ما بتبرد",
      address: "عمان - الهاشمي الشمالي",
      external_ref: "SR-2026-000009",
    });

    expect(r.statusCode).toBe(201);
    expect(r.json().data).toMatchObject({
      status: "confirmed",
      start_at: slot.start_at,
      staff_id: s.staffId,
      customer_name: "سامر",
      customer_phone: "+962795550100",
      description: "ثلاجة LG — ما بتبرد",
      external_ref: "SR-2026-000009",
      visit_fee_jod: "10.000",
      label_ar: "الأحد 8 تشرين الثاني، الساعة 9 الصبح",
    });
    expect(r.json().display_ar).toBe("تم تثبيت موعدك ✅ الأحد 8 تشرين الثاني الساعة 9 الصبح. إذا بدك تغيّر أو تلغي احكيلنا هون.");

    const { rows } = await pool.query(
      `SELECT b.status, h.action, h.by FROM bookings b JOIN booking_history h ON h.booking_id = b.id WHERE b.business_id = $1`,
      [s.businessId],
    );
    expect(rows).toEqual([{ status: "confirmed", action: "created", by: "api" }]);
  });

  it("answers SLOT_TAKEN with fresh alternatives when the same slot is booked twice", async () => {
    const s = await shop();
    const [slot] = (await getSlots(s, 1)).slots;
    expect((await book(s, { slot_token: slot.slot_token, ...customer })).statusCode).toBe(201);

    const again = await book(s, { slot_token: slot.slot_token, ...customer });
    expect(again.statusCode).toBe(409);
    const err = again.json().error;
    expect(err.code).toBe("SLOT_TAKEN");
    expect(err.alternatives).toHaveLength(3);
    expect(err.alternatives.every((a: { slot_token: string; start_at: string }) => a.slot_token.startsWith("st_") && a.start_at !== slot.start_at)).toBe(true);
    expect(err.display_ar.startsWith("للأسف هالموعد انحجز هلأ 😅 هاي أقرب مواعيد فاضية:\n1) ")).toBe(true);
  });

  it("gives the booking to another staff member when the chosen one just got busy", async () => {
    const s = await shop();
    const second = await addStaff(pool, s.businessId, "سامر", [s.serviceId]);
    await setDefaultHours(pool, second);
    await pool.query("INSERT INTO staff_zones (staff_id, zone_id) VALUES ($1, $2)", [second, s.zoneId]);

    const [slot] = (await getSlots(s, 1)).slots;
    const first = await book(s, { slot_token: slot.slot_token, ...customer });
    expect(first.json().data.staff_id).toBe(s.staffId);

    const next = await book(s, { slot_token: slot.slot_token, ...customer, customer_name: "ليث" });
    expect(next.statusCode).toBe(201);
    expect(next.json().data.staff_id).toBe(second);

    expect((await book(s, { slot_token: slot.slot_token, ...customer })).statusCode).toBe(409);
  });

  it("rejects expired, tampered and foreign slot tokens", async () => {
    const s = await shop();
    const other = await shop();
    const [slot] = (await getSlots(s, 1)).slots;

    clock.now = new Date(BASE.getTime() + 16 * 60_000); // tokens live 15 minutes
    const expired = await book(s, { slot_token: slot.slot_token, ...customer });
    expect(expired.statusCode).toBe(422);
    expect(expired.json().error).toMatchObject({ code: "SLOT_TOKEN_EXPIRED", display_ar: "خليني أجيبلك المواعيد الفاضية من جديد." });
    clock.now = BASE;

    const last = slot.slot_token.slice(-1);
    const tampered = slot.slot_token.slice(0, -1) + (last === "A" ? "B" : "A");
    expect((await book(s, { slot_token: tampered, ...customer })).json().error.code).toBe("INVALID_INPUT");
    expect((await book(other, { slot_token: slot.slot_token, ...customer })).json().error.code).toBe("INVALID_INPUT");
  });

  it("rejects a bad phone number, a missing name and a reused reference", async () => {
    const s = await shop();
    const [a, b] = (await getSlots(s, 2)).slots;

    const phone = await book(s, { slot_token: a.slot_token, customer_name: "سامر", customer_phone: "12345" });
    expect(phone.statusCode).toBe(422);
    expect(phone.json().error).toMatchObject({ code: "INVALID_PHONE", display_ar: "الرقم مش واضح، ابعته بالشكل 07XXXXXXXX" });

    const noName = await book(s, { slot_token: a.slot_token, customer_phone: "0795550100" });
    expect(noName.statusCode).toBe(422);
    expect(noName.json().error.code).toBe("INVALID_INPUT");

    expect((await book(s, { slot_token: a.slot_token, ...customer, external_ref: "SR-1" })).statusCode).toBe(201);
    const reused = await book(s, { slot_token: b.slot_token, ...customer, external_ref: "SR-1" });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe("INVALID_INPUT");
  });
});

const check = (s: Shop, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/v1/availability/check",
    headers: auth(s.key),
    payload: { service: "ثلاجة", zone: "هاشمي شمالي", ...payload },
  });

describe("POST /v1/availability/check", () => {
  it("says yes with a bookable slot when the time is free ('ع الخمسة')", async () => {
    const s = await shop();
    const r = await check(s, { date: "بكرا", time: "ع الخمسة" });

    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d).toMatchObject({
      available: true,
      reason_code: null,
      requested: { local_date: "2026-11-08", local_time: "17:00" },
      alternatives: [],
    });
    expect(d.slot).toMatchObject({ start_at: "2026-11-08T14:00:00.000Z", label_ar: "الأحد 8 تشرين الثاني، الساعة 5 المسا" });
    expect(d.slot_token).toBe(d.slot.slot_token);
    expect(r.json().display_ar).toBe("تمام، بكرا الأحد الساعة 5 المسا متاح ✅ بدك أثبتلك الموعد؟");

    expect((await book(s, { slot_token: d.slot_token, ...customer })).statusCode).toBe(201); // the token is bookable as is
  });

  it("says no when the time is taken and offers the nearest times, same day first", async () => {
    const s = await shop();
    const free = (await check(s, { date: "بكرا", time: "5 المسا" })).json().data;
    await book(s, { slot_token: free.slot_token, ...customer });

    const r = await check(s, { date: "بكرا", time: "5 المسا" });
    const d = r.json().data;
    expect(d).toMatchObject({ available: false, reason_code: "FULLY_BOOKED", slot_token: null, slot: null });
    expect(d.alternatives.map((a: { local_time: string }) => a.local_time)).toEqual(["14:30", "15:00", "15:30"]);
    expect(r.json().display_ar).toBe(
      "للأسف بكرا الأحد الساعة 5 المسا مش متاحة 🙏 أقرب مواعيد فاضية: بكرا الأحد الساعة 2 ونص الظهر، بكرا الأحد الساعة 3 العصر، أو بكرا الأحد الساعة 3 ونص العصر. شو بناسبك؟",
    );
  });

  it("explains why a time is not possible", async () => {
    const s = await shop();
    await pool.query("INSERT INTO days_off (business_id, during, reason) VALUES ($1, tstzrange($2, $3, '[)'), 'عيد')", [
      s.businessId, "2026-11-08T21:00:00Z", "2026-11-09T21:00:00Z", // all of Monday 9 Nov, Amman time
    ]);
    const reason = async (payload: Record<string, unknown>) => (await check(s, payload)).json().data.reason_code;

    expect(await reason({ date: "اليوم", time: "4 الصبح" })).toBe("TOO_SOON");
    expect(await reason({ date: "2026-11-30", time: "10" })).toBe("BEYOND_HORIZON");
    expect(await reason({ date: "2026-11-13", time: "10" })).toBe("DAY_OFF"); // Friday
    expect(await reason({ date: "2026-11-09", time: "10" })).toBe("CLOSURE");
    expect(await reason({ date: "بكرا", time: "8" })).toBe("OUTSIDE_WORKING_HOURS");
    expect(await reason({ date: "بكرا", time: "10:10" })).toBe("NOT_A_SLOT_TIME");
  });

  it("offers sensible alternatives around the request", async () => {
    const s = await shop();

    const offGrid = (await check(s, { date: "بكرا", time: "10:10" })).json().data.alternatives;
    expect(offGrid.map((a: { local_time: string }) => a.local_time)).toEqual(["09:30", "10:00", "10:30"]);

    const friday = (await check(s, { date: "2026-11-13", time: "10" })).json().data.alternatives; // day off -> next working day
    expect(friday[0]).toMatchObject({ local_date: "2026-11-14", local_time: "09:00" });

    const far = await check(s, { date: "2026-11-30", time: "10" }); // beyond the 14-day horizon: nothing to offer
    expect(far.json().data.alternatives).toEqual([]);
    expect(far.json().display_ar).toContain("وما في مواعيد فاضية قريبة");
  });

  it("accepts an exact start_at instead of date + time", async () => {
    const s = await shop();
    for (const start_at of ["2026-11-08T14:00:00+03:00", "2026-11-08T11:00:00Z"]) {
      const d = (await check(s, { start_at })).json().data;
      expect(d).toMatchObject({ available: true, requested: { local_date: "2026-11-08", local_time: "14:00" } });
    }
  });

  it("validates the request", async () => {
    const s = await shop();
    const bad = async (payload: Record<string, unknown>) => {
      const r = await check(s, payload);
      return { status: r.statusCode, code: r.json().error.code, text: r.json().error.display_ar as string | null };
    };

    expect(await bad({ service: "غسالة", date: "بكرا", time: "5" })).toMatchObject({ status: 422, code: "SERVICE_NOT_FOUND" });
    expect(await bad({})).toMatchObject({ status: 422, code: "INVALID_INPUT" });
    expect(await bad({ date: "بكرا" })).toMatchObject({ status: 422, code: "INVALID_INPUT" });
    expect(await bad({ start_at: "yesterday" })).toMatchObject({ status: 422, code: "INVALID_INPUT" });

    const time = await bad({ date: "بكرا", time: "blah" });
    expect(time).toMatchObject({ status: 422, code: "INVALID_INPUT" });
    expect(time.text!.startsWith("ما فهمت الوقت")).toBe(true);
    const date = await bad({ date: "الخميس", time: "5" });
    expect(date.text!.startsWith("ما فهمت اليوم")).toBe(true);
  });
});

describe("Idempotency-Key on POST /v1/bookings", () => {
  const withKey = (s: Shop, key: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/bookings", headers: { ...auth(s.key), "idempotency-key": key }, payload });
  const count = async (s: Shop) =>
    (await pool.query("SELECT count(*)::int AS n FROM bookings WHERE business_id = $1", [s.businessId])).rows[0].n as number;

  it("returns the first result when the bot retries, and never books twice", async () => {
    const s = await shop();
    const [slot] = (await getSlots(s, 1)).slots;
    const payload = { slot_token: slot.slot_token, ...customer, external_ref: "SR-1" };

    const first = await withKey(s, "retry-1", payload);
    const retry = await withKey(s, "retry-1", payload);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(retry.json().data.id).toBe(first.json().data.id);
    expect(retry.json().display_ar).toBe(first.json().display_ar);
    expect(await count(s)).toBe(1);
  });

  it("refuses to reuse a key for a different request", async () => {
    const s = await shop();
    const [slot] = (await getSlots(s, 1)).slots;
    await withKey(s, "reuse-1", { slot_token: slot.slot_token, ...customer });

    const other = await withKey(s, "reuse-1", { slot_token: slot.slot_token, ...customer, customer_name: "ليث" });
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await count(s)).toBe(1);
  });

  it("does not remember failures, so the same key can be used again after fixing the request", async () => {
    const s = await shop();
    const [slot] = (await getSlots(s, 1)).slots;

    const bad = await withKey(s, "fix-1", { slot_token: slot.slot_token, customer_name: "سامر", customer_phone: "12345" });
    expect(bad.json().error.code).toBe("INVALID_PHONE");

    const fixed = await withKey(s, "fix-1", { slot_token: slot.slot_token, ...customer });
    expect(fixed.statusCode).toBe(201);
  });

  it("forgets keys after 24 hours", async () => {
    const s = await shop();
    const [slot] = (await getSlots(s, 1)).slots;
    const payload = { slot_token: slot.slot_token, ...customer };
    expect((await withKey(s, "old-1", payload)).statusCode).toBe(201);

    await pool.query("UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE business_id = $1", [s.businessId]);
    const again = await withKey(s, "old-1", payload);
    expect(again.statusCode).toBe(409); // executed again for real: the slot is already booked
    expect(again.json().error.code).toBe("SLOT_TAKEN");
  });

  it("tells the caller to retry later while the first request is still running", async () => {
    const s = await shop();
    const [slot] = (await getSlots(s, 1)).slots;
    await pool.query("INSERT INTO idempotency_keys (business_id, key, request_hash) VALUES ($1, 'busy-1', 'x')", [s.businessId]);

    const r = await withKey(s, "busy-1", { slot_token: slot.slot_token, ...customer });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(await count(s)).toBe(0);
  });

  it("books exactly once when the same request arrives 5 times at the same moment", async () => {
    const s = await shop();
    const [slot] = (await getSlots(s, 1)).slots;
    const payload = { slot_token: slot.slot_token, ...customer };

    const results = await Promise.all(Array.from({ length: 5 }, () => withKey(s, "par-1", payload)));

    const created = results.filter((r) => r.statusCode === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((r) => r.json().data.id)).size).toBe(1);
    for (const r of results.filter((x) => x.statusCode !== 201)) {
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    }
    expect(await count(s)).toBe(1);
  });

  it("rejects an absurdly long key", async () => {
    const s = await shop();
    const [slot] = (await getSlots(s, 1)).slots;
    const r = await withKey(s, "k".repeat(300), { slot_token: slot.slot_token, ...customer });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("INVALID_INPUT");
  });
});
