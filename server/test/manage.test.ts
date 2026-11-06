import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { BASE, PEPPER, SECRET, auth, customer, shop, type Shop } from "./fixtures.js";
import { addService, testPool } from "./helpers.js";

const pool = testPool(10);
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

const call = (s: Shop, method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>, query?: Record<string, string>) =>
  app.inject({ method, url, headers: auth(s.key), ...(payload && { payload }), ...(query && { query }) });

const check = (s: Shop, payload: Record<string, unknown>) =>
  call(s, "POST", "/v1/availability/check", { service: "ثلاجة", zone: "هاشمي شمالي", date: "بكرا", ...payload });

/** Books tomorrow (Sunday 8 Nov) at `time` and returns the booking. */
async function bookAt(s: Shop, time: string, extra: Record<string, unknown> = {}) {
  const found = (await check(s, { time })).json().data;
  if (!found.available) throw new Error(`test setup: ${time} is not free`);
  const r = await call(s, "POST", "/v1/bookings", { slot_token: found.slot_token, ...customer, ...extra });
  if (r.statusCode !== 201) throw new Error(`test setup: booking failed ${r.body}`);
  return r.json().data as { id: string; start_at: string; status: string };
}
const statusInDb = async (id: string) => (await pool.query("SELECT status FROM bookings WHERE id = $1", [id])).rows[0].status as string;

describe("finding bookings", () => {
  it("finds a customer's bookings by phone in any format, in time order, only in their own business", async () => {
    const s = await shop(pool);
    const other = await shop(pool);
    await bookAt(s, "12");
    await bookAt(s, "9");
    await bookAt(other, "9");

    const r = await call(s, "GET", "/v1/bookings", undefined, { phone: "٠٧٩٥٥٥٠١٠٠" });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.bookings.map((b: { start_at: string }) => b.start_at)).toEqual([
      "2026-11-08T06:00:00.000Z",
      "2026-11-08T09:00:00.000Z",
    ]);
    expect(r.json().display_ar).toBe("عندك حجزين:\n1) بكرا الأحد الساعة 9 الصبح\n2) بكرا الأحد الساعة 12 الظهر");
  });

  it("finds by external_ref and shows the description; unknown reference is just an empty list", async () => {
    const s = await shop(pool);
    await bookAt(s, "9", { external_ref: "SR-2026-000009", description: "ثلاجة LG — ما بتبرد" });

    const hit = await call(s, "GET", "/v1/bookings", undefined, { external_ref: "SR-2026-000009" });
    expect(hit.json().data.bookings).toHaveLength(1);
    expect(hit.json().data.bookings[0]).toMatchObject({ external_ref: "SR-2026-000009", customer_phone: "+962795550100" });
    expect(hit.json().display_ar).toBe("عندك حجز واحد:\n1) بكرا الأحد الساعة 9 الصبح (ثلاجة LG — ما بتبرد)");

    const none = await call(s, "GET", "/v1/bookings", undefined, { external_ref: "SR-NOPE" });
    expect(none.statusCode).toBe(200);
    expect(none.json().data.bookings).toEqual([]);
    expect(none.json().display_ar).toBe("ما لقيت أي حجز.");
  });

  it("filters by status and by local date range, and validates the filters", async () => {
    const s = await shop(pool);
    await bookAt(s, "9");

    const q = (query: Record<string, string>) => call(s, "GET", "/v1/bookings", undefined, query);
    expect((await q({ status: "confirmed" })).json().data.bookings).toHaveLength(1);
    expect((await q({ status: "cancelled" })).json().data.bookings).toHaveLength(0);
    expect((await q({ from: "2026-11-08", to: "2026-11-08" })).json().data.bookings).toHaveLength(1);
    expect((await q({ from: "2026-11-09" })).json().data.bookings).toHaveLength(0);
    expect((await q({ to: "2026-11-07" })).json().data.bookings).toHaveLength(0);

    const badPhone = await q({ phone: "12345" });
    expect(badPhone.statusCode).toBe(422);
    expect(badPhone.json().error.code).toBe("INVALID_PHONE");
    expect((await q({ status: "done" })).json().error.code).toBe("INVALID_INPUT");
  });

  it("returns one booking with its history", async () => {
    const s = await shop(pool);
    const bk = await bookAt(s, "9");
    const r = await call(s, "GET", `/v1/bookings/${bk.id}`);

    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ id: bk.id, status: "confirmed", label_ar: "الأحد 8 تشرين الثاني، الساعة 9 الصبح" });
    expect(r.json().data.history).toMatchObject([{ action: "created", by: "api" }]);
    expect(r.json().display_ar).toBe("موعدك: بكرا الأحد الساعة 9 الصبح. الحالة: مؤكد.");
  });

  it("answers 404 for a malformed id", async () => {
    const s = await shop(pool);
    const r = await call(s, "GET", "/v1/bookings/not-an-id");
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("NOT_FOUND");
  });
});

describe("PATCH /v1/bookings/:id", () => {
  it("edits customer data, normalizes the phone, can clear a field, and records it in the history", async () => {
    const s = await shop(pool);
    const bk = await bookAt(s, "9", { description: "قديم", address: "عمان" });

    const r = await call(s, "PATCH", `/v1/bookings/${bk.id}`, {
      customer_name: "ليث",
      customer_phone: "٠٧٩١٢٣٤٥٦٧",
      description: null,
      external_ref: "SR-77",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({
      customer_name: "ليث",
      customer_phone: "+962791234567",
      description: null,
      address: "عمان",
      external_ref: "SR-77",
    });
    expect(r.json().display_ar).toBe("تم تعديل بيانات الحجز ✅");

    const history = (await call(s, "GET", `/v1/bookings/${bk.id}`)).json().data.history;
    expect(history.at(-1).action).toBe("updated");
    expect([...history.at(-1).data.changed].sort()).toEqual(["customer_name", "customer_phone", "description", "external_ref"]);
  });

  it("rejects an empty edit, a bad phone, and a reference that another booking already uses", async () => {
    const s = await shop(pool);
    const a = await bookAt(s, "9", { external_ref: "SR-1" });
    const b = await bookAt(s, "12");

    expect((await call(s, "PATCH", `/v1/bookings/${b.id}`, {})).json().error.code).toBe("INVALID_INPUT");
    expect((await call(s, "PATCH", `/v1/bookings/${b.id}`, { customer_phone: "123" })).json().error.code).toBe("INVALID_PHONE");
    const clash = await call(s, "PATCH", `/v1/bookings/${b.id}`, { external_ref: "SR-1" });
    expect(clash.statusCode).toBe(422);
    expect(clash.json().error.code).toBe("INVALID_INPUT");
    expect(a.id).not.toBe(b.id);
  });
});

describe("POST /v1/bookings/:id/reschedule", () => {
  it("moves a booking one hour later even though its own travel gap blocks that time for anyone else", async () => {
    const s = await shop(pool);
    const bk = await bookAt(s, "9"); // 09:00–10:00, blocked until 10:30

    expect((await check(s, { time: "10" })).json().data).toMatchObject({ available: false, reason_code: "FULLY_BOOKED" });
    const mine = (await check(s, { time: "10", booking_id: bk.id })).json().data;
    expect(mine.available).toBe(true);

    const r = await call(s, "POST", `/v1/bookings/${bk.id}/reschedule`, { slot_token: mine.slot_token });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ id: bk.id, status: "confirmed", start_at: "2026-11-08T07:00:00.000Z" });
    expect(r.json().display_ar).toBe("تم تغيير موعدك ✅ موعدك الجديد: الأحد 8 تشرين الثاني الساعة 10 الصبح.");

    const history = (await call(s, "GET", `/v1/bookings/${bk.id}`)).json().data.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(["created", "rescheduled"]);
    expect((await pool.query("SELECT count(*)::int AS n FROM bookings WHERE business_id = $1", [s.businessId])).rows[0].n).toBe(1);
  });

  it("is safe to repeat: moving to the time it already has changes nothing", async () => {
    const s = await shop(pool);
    const bk = await bookAt(s, "9");
    const same = (await check(s, { time: "9", booking_id: bk.id })).json().data;

    const r = await call(s, "POST", `/v1/bookings/${bk.id}/reschedule`, { slot_token: same.slot_token });
    expect(r.statusCode).toBe(200);
    const history = (await call(s, "GET", `/v1/bookings/${bk.id}`)).json().data.history;
    expect(history).toHaveLength(1);
  });

  it("answers SLOT_TAKEN with alternatives when the new time was just taken, and leaves the booking where it was", async () => {
    const s = await shop(pool);
    const mine = await bookAt(s, "9");
    const stale = (await check(s, { time: "2 العصر", booking_id: mine.id })).json().data.slot_token;
    await call(s, "POST", "/v1/bookings", { slot_token: stale, ...customer, customer_name: "ليث" }); // someone else takes 14:00

    const r = await call(s, "POST", `/v1/bookings/${mine.id}/reschedule`, { slot_token: stale });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("SLOT_TAKEN");
    expect(r.json().error.alternatives.length).toBeGreaterThan(0);
    expect((await call(s, "GET", `/v1/bookings/${mine.id}`)).json().data.start_at).toBe(mine.start_at);
  });

  it("refuses a slot for a different service, and a booking that is no longer confirmed", async () => {
    const s = await shop(pool);
    const bk = await bookAt(s, "9");
    const washer = await addService(pool, s.businessId, "صيانة غسالة", 60);
    await pool.query("INSERT INTO staff_services (staff_id, service_id) VALUES ($1, $2)", [s.staffId, washer]);
    const other = (await check(s, { service: washer, time: "3" })).json().data.slot_token;
    const wrong = await call(s, "POST", `/v1/bookings/${bk.id}/reschedule`, { slot_token: other });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe("INVALID_INPUT");

    await call(s, "POST", `/v1/bookings/${bk.id}/cancel`, {});
    const token = (await check(s, { time: "3" })).json().data.slot_token;
    const moved = await call(s, "POST", `/v1/bookings/${bk.id}/reschedule`, { slot_token: token });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.code).toBe("INVALID_TRANSITION");
  });
});

describe("POST /v1/bookings/:id/cancel", () => {
  it("cancels with a reason, frees the time, and is safe to repeat", async () => {
    const s = await shop(pool);
    const bk = await bookAt(s, "9");

    const r = await call(s, "POST", `/v1/bookings/${bk.id}/cancel`, { reason: "الزبون غيّر رأيه" });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.status).toBe("cancelled");
    expect(r.json().display_ar).toBe("تم إلغاء موعدك ✅ إذا بدك تحجز موعد جديد احكيلنا.");
    expect((await check(s, { time: "9" })).json().data.available).toBe(true);

    const again = await call(s, "POST", `/v1/bookings/${bk.id}/cancel`, {});
    expect(again.statusCode).toBe(200);
    expect(again.json().data.status).toBe("cancelled");

    // a lookup must not present a cancelled booking as if it were still on
    const listed = await call(s, "GET", "/v1/bookings", undefined, { phone: "0795550100" });
    expect(listed.json().display_ar).toBe("عندك حجز واحد:\n1) بكرا الأحد الساعة 9 الصبح — ملغي");

    const history = (await call(s, "GET", `/v1/bookings/${bk.id}`)).json().data.history;
    expect(history.map((h: { action: string }) => h.action)).toEqual(["created", "cancelled"]);
    expect(history[1].data.reason).toBe("الزبون غيّر رأيه");
  });

  it("works without a body", async () => {
    const s = await shop(pool);
    const bk = await bookAt(s, "9");
    const r = await app.inject({ method: "POST", url: `/v1/bookings/${bk.id}/cancel`, headers: auth(s.key) });
    expect(r.statusCode).toBe(200);
  });

  it("is refused through the API when the visit is closer than the cut-off (2 h by default, configurable)", async () => {
    const s = await shop(pool);
    const bk = await bookAt(s, "9"); // Sunday 09:00 Amman = 06:00Z

    clock.now = new Date("2026-11-08T05:00:00Z"); // 08:00 Amman, one hour before
    const cancel = await call(s, "POST", `/v1/bookings/${bk.id}/cancel`, {});
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error).toMatchObject({
      code: "TOO_LATE_TO_CHANGE",
      display_ar: "الموعد قريب كتير وما بنقدر نغيّره هلأ، رح نحوّلك لصاحب المحل.",
    });
    const token = (await check(s, { date: "2026-11-09", time: "10" })).json().data.slot_token;
    const move = await call(s, "POST", `/v1/bookings/${bk.id}/reschedule`, { slot_token: token });
    expect(move.json().error.code).toBe("TOO_LATE_TO_CHANGE");
    expect(await statusInDb(bk.id)).toBe("confirmed");

    await pool.query(`UPDATE businesses SET settings = settings || '{"change_cutoff_min":30}' WHERE id = $1`, [s.businessId]);
    expect((await call(s, "POST", `/v1/bookings/${bk.id}/cancel`, {})).statusCode).toBe(200);
  });
});

describe("POST /v1/bookings/:id/status", () => {
  it("marks a visit completed, is safe to repeat, and refuses impossible changes", async () => {
    const s = await shop(pool);
    const bk = await bookAt(s, "9");
    const set = (status: string) => call(s, "POST", `/v1/bookings/${bk.id}/status`, { status });

    const done = await set("completed");
    expect(done.statusCode).toBe(200);
    expect(done.json().data.status).toBe("completed");
    expect(done.json().display_ar).toBe("تم تحديث حالة الحجز ✅");
    expect((await set("completed")).statusCode).toBe(200);

    expect((await set("no_show")).json().error.code).toBe("INVALID_TRANSITION");
    expect((await set("cancelled")).json().error.code).toBe("INVALID_INPUT");
    const cancel = await call(s, "POST", `/v1/bookings/${bk.id}/cancel`, {});
    expect(cancel.json().error.code).toBe("INVALID_TRANSITION");
    expect(await statusInDb(bk.id)).toBe("completed");
  });
});

describe("isolation and Idempotency-Key", () => {
  it("never lets one business touch another's booking", async () => {
    const a = await shop(pool);
    const b = await shop(pool);
    const bk = await bookAt(a, "9");
    const token = (await check(b, { time: "9" })).json().data.slot_token;

    const attempts = [
      call(b, "GET", `/v1/bookings/${bk.id}`),
      call(b, "PATCH", `/v1/bookings/${bk.id}`, { customer_name: "x" }),
      call(b, "POST", `/v1/bookings/${bk.id}/cancel`, {}),
      call(b, "POST", `/v1/bookings/${bk.id}/status`, { status: "completed" }),
      call(b, "POST", `/v1/bookings/${bk.id}/reschedule`, { slot_token: token }),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("NOT_FOUND");
    }
    expect(await statusInDb(bk.id)).toBe("confirmed");
    expect((await call(b, "GET", "/v1/bookings", undefined, { phone: "0795550100" })).json().data.bookings).toEqual([]);
  });

  it("does not let one Idempotency-Key stand for two different bookings", async () => {
    const s = await shop(pool);
    const a = await bookAt(s, "9");
    const b = await bookAt(s, "12");
    const withKey = (id: string) =>
      app.inject({ method: "POST", url: `/v1/bookings/${id}/cancel`, headers: { ...auth(s.key), "idempotency-key": "same-key" }, payload: {} });

    expect((await withKey(a.id)).statusCode).toBe(200);
    const second = await withKey(b.id);
    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await statusInDb(b.id)).toBe("confirmed");
  });
});
