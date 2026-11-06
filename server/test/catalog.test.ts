import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { BASE, PEPPER, SECRET, auth, bareShop, customer, shop } from "./fixtures.js";
import { testPool } from "./helpers.js";

const pool = testPool(10);
const clock = { now: BASE }; // Saturday 7 Nov 2026, 03:00 Amman; "tomorrow" = Sunday 8 Nov
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

type Who = { key: string };
const call = (
  s: Who,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
  query?: Record<string, string>,
  headers: Record<string, string> = {},
) => app.inject({ method, url, headers: { ...auth(s.key), ...headers }, ...(payload && { payload }), ...(query && { query }) });

const create = async (s: Who, url: string, payload: Record<string, unknown>) => {
  const r = await call(s, "POST", url, payload);
  if (r.statusCode !== 201) throw new Error(`setup failed: POST ${url} -> ${r.statusCode} ${r.body}`);
  return r.json().data as Record<string, any>;
};

/** Local start times offered on Sunday 8 Nov (or another day) for the fridge service. */
async function times(s: Who, query: Record<string, string> = {}) {
  const r = await call(s, "GET", "/v1/availability", undefined, {
    service: "ثلاجة", date_from: "2026-11-08", date_to: "2026-11-08", limit: "20", ...query,
  });
  if (r.statusCode !== 200) throw new Error(`availability failed: ${r.body}`);
  return (r.json().data.slots as { local_time: string }[]).map((x) => x.local_time);
}
const book = async (s: Who, time: string) => {
  const found = (await call(s, "POST", "/v1/availability/check", { service: "ثلاجة", zone: "هاشمي شمالي", date: "بكرا", time })).json().data;
  const r = await call(s, "POST", "/v1/bookings", { slot_token: found.slot_token, ...customer });
  if (r.statusCode !== 201) throw new Error(`booking failed: ${r.body}`);
  return r.json().data as { id: string };
};

describe("setting up a business through the API", () => {
  it("a business built from nothing takes a booking", async () => {
    const s = await bareShop(pool);

    const service = await create(s, "/v1/services", { name_ar: "صيانة ثلاجة", aliases: ["ثلاجة"], duration_min: 60 });
    const zone = await create(s, "/v1/zones", { name_ar: "الهاشمي الشمالي", visit_fee_jod: 10 });
    const staff = await create(s, "/v1/staff", { name_ar: "محمود", service_ids: [service.id], zone_ids: [zone.id] });

    expect(zone.visit_fee_jod).toBe("10.000");
    expect(staff.hours).toHaveLength(6); // default week
    const found = await call(s, "GET", "/v1/availability", undefined, {
      service: "ثلاجة", zone: "هاشمي شمالي", date_from: "2026-11-08", date_to: "2026-11-08",
    });
    expect(found.json().data.slots.map((x: { local_time: string }) => x.local_time)).toEqual(["09:00", "12:00", "14:00"]);

    const booked = await call(s, "POST", "/v1/bookings", { slot_token: found.json().data.slots[0].slot_token, ...customer });
    expect(booked.statusCode).toBe(201);
    expect(booked.json().data.visit_fee_jod).toBe("10.000");
  });

  it("answers setup calls with display_ar null (they are not customer messages)", async () => {
    const s = await bareShop(pool);
    const r = await call(s, "POST", "/v1/services", { name_ar: "صيانة", duration_min: 30 });
    expect(r.statusCode).toBe(201);
    expect(r.json().display_ar).toBeNull();
    expect((await call(s, "GET", "/v1/services")).json().display_ar).toBeNull();
  });

  it("needs an API key on every setup endpoint", async () => {
    const targets: [string, string][] = [
      ["GET", "/v1/business"], ["PATCH", "/v1/business"],
      ["GET", "/v1/staff"], ["POST", "/v1/staff"],
      ["GET", "/v1/services"], ["POST", "/v1/services"],
      ["GET", "/v1/zones"], ["POST", "/v1/zones"],
      ["GET", "/v1/days-off"], ["POST", "/v1/days-off"],
    ];
    for (const [method, url] of targets) {
      const r = await app.inject({ method: method as "GET", url });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("staff", () => {
  it("gets the Saturday–Thursday 09:00–18:00 week unless hours are given, and links services and zones", async () => {
    const s = await bareShop(pool);
    const service = await create(s, "/v1/services", { name_ar: "صيانة", duration_min: 60 });
    const zone = await create(s, "/v1/zones", { name_ar: "عبدون" });

    const plain = await create(s, "/v1/staff", { name_ar: "محمود", phone: "٠٧٩١٢٣٤٥٦٧", color: "#22C77A" });
    expect(plain).toMatchObject({ name_ar: "محمود", phone: "+962791234567", color: "#22C77A", active: true, service_ids: [], zone_ids: [] });
    expect(plain.hours.map((h: { weekday: number }) => h.weekday).sort()).toEqual([0, 1, 2, 3, 4, 6]);
    expect(plain.hours[0]).toMatchObject({ start: "09:00", end: "18:00" });

    const custom = await create(s, "/v1/staff", {
      name_ar: "سامر",
      service_ids: [service.id],
      zone_ids: [zone.id],
      hours: [{ weekday: 0, start: "10:00", end: "12:00" }],
    });
    expect(custom.hours).toEqual([{ weekday: 0, start: "10:00", end: "12:00" }]);
    expect(custom.service_ids).toEqual([service.id]);
    expect(custom.zone_ids).toEqual([zone.id]);

    const one = await call(s, "GET", `/v1/staff/${custom.id}`);
    expect(one.json().data.id).toBe(custom.id);
    expect((await call(s, "GET", "/v1/staff")).json().data.staff).toHaveLength(2);
  });

  it("edits a staff member, including which services they do", async () => {
    const s = await bareShop(pool);
    const a = await create(s, "/v1/services", { name_ar: "ثلاجة", duration_min: 60 });
    const b = await create(s, "/v1/services", { name_ar: "غسالة", duration_min: 60 });
    const staff = await create(s, "/v1/staff", { name_ar: "محمود", service_ids: [a.id] });

    const r = await call(s, "PATCH", `/v1/staff/${staff.id}`, { name_ar: "محمود العلي", name_en: "Mahmoud", color: "#8B6CF6", service_ids: [b.id] });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ name_ar: "محمود العلي", name_en: "Mahmoud", color: "#8B6CF6", service_ids: [b.id] });
    expect(r.json().data.hours).toHaveLength(6); // untouched
  });

  it("refuses unknown fields, a bad phone, and ids that belong to another business", async () => {
    const s = await bareShop(pool);
    const other = await bareShop(pool);
    const foreign = await create(other, "/v1/services", { name_ar: "ثلاجة", duration_min: 60 });

    const unknown = await call(s, "POST", "/v1/staff", { name_ar: "محمود", salary: 1000 });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.code).toBe("INVALID_INPUT");
    expect((await call(s, "POST", "/v1/staff", { name_ar: "محمود", phone: "123" })).json().error.code).toBe("INVALID_PHONE");
    expect((await call(s, "POST", "/v1/staff", { name_ar: "محمود", color: "red" })).json().error.code).toBe("INVALID_INPUT");

    const foreignRef = await call(s, "POST", "/v1/staff", { name_ar: "محمود", service_ids: [foreign.id] });
    expect(foreignRef.statusCode).toBe(422);
    expect(foreignRef.json().error.code).toBe("INVALID_INPUT");
    expect(foreignRef.json().error.fields[0].path).toBe("service_ids");
    expect((await call(s, "GET", "/v1/staff")).json().data.staff).toHaveLength(0); // nothing half-created
  });

  it("replaces the working hours (Sunday = 0) and availability follows", async () => {
    const s = await bareShop(pool);
    const service = await create(s, "/v1/services", { name_ar: "ثلاجة", aliases: ["ثلاجة"], duration_min: 60 });
    const staff = await create(s, "/v1/staff", { name_ar: "محمود", service_ids: [service.id] });
    expect((await times(s))[0]).toBe("09:00");

    const r = await call(s, "PUT", `/v1/staff/${staff.id}/hours`, {
      hours: [{ weekday: 0, start: "10:00", end: "12:00" }, { weekday: 1, start: "09:00", end: "13:00" }, { weekday: 1, start: "16:00", end: "20:00" }],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.hours).toEqual([
      { weekday: 0, start: "10:00", end: "12:00" },
      { weekday: 1, start: "09:00", end: "13:00" },
      { weekday: 1, start: "16:00", end: "20:00" },
    ]);
    expect(await times(s)).toEqual(["10:00", "10:30", "11:00"]); // Sunday

    expect((await call(s, "PUT", `/v1/staff/${staff.id}/hours`, { hours: [] })).statusCode).toBe(200);
    expect(await times(s)).toEqual([]); // never works
  });

  it("refuses overlapping, backwards or malformed hours and keeps the old ones", async () => {
    const s = await bareShop(pool);
    const staff = await create(s, "/v1/staff", { name_ar: "محمود" });
    const put = (hours: unknown[]) => call(s, "PUT", `/v1/staff/${staff.id}/hours`, { hours } as Record<string, unknown>);

    expect((await put([{ weekday: 0, start: "09:00", end: "13:00" }, { weekday: 0, start: "12:00", end: "15:00" }])).json().error.code).toBe("INVALID_INPUT");
    expect((await put([{ weekday: 0, start: "13:00", end: "09:00" }])).json().error.code).toBe("INVALID_INPUT");
    expect((await put([{ weekday: 0, start: "9:00", end: "13:00" }])).json().error.code).toBe("INVALID_INPUT");
    expect((await put([{ weekday: 7, start: "09:00", end: "13:00" }])).json().error.code).toBe("INVALID_INPUT");
    expect((await call(s, "GET", `/v1/staff/${staff.id}`)).json().data.hours).toHaveLength(6);
  });

  it("is deactivated, not erased — and not while it still has upcoming visits", async () => {
    const s = await shop(pool);
    const booking = await book(s, "9");

    const refused = await call(s, "DELETE", `/v1/staff/${s.staffId}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("HAS_UPCOMING_BOOKINGS");

    await call(s, "POST", `/v1/bookings/${booking.id}/cancel`, {});
    const done = await call(s, "DELETE", `/v1/staff/${s.staffId}`);
    expect(done.statusCode).toBe(200);
    expect(done.json().data.active).toBe(false);
    expect(await times(s)).toEqual([]);
    expect((await call(s, "GET", "/v1/staff")).json().data.staff).toHaveLength(0);
    expect((await call(s, "GET", "/v1/staff", undefined, { include_inactive: "true" })).json().data.staff).toHaveLength(1);

    expect((await call(s, "DELETE", `/v1/staff/${s.staffId}`)).statusCode).toBe(200); // repeating is harmless
    expect((await call(s, "PATCH", `/v1/staff/${s.staffId}`, { active: true })).json().data.active).toBe(true);
    expect((await times(s)).length).toBeGreaterThan(0);
  });
});

describe("services", () => {
  it("creates, edits and deactivates; the duration decides how many slots there are", async () => {
    const s = await bareShop(pool);
    const service = await create(s, "/v1/services", { name_ar: "صيانة ثلاجة", name_en: "Fridge repair", aliases: ["ثلاجة", "براد"], duration_min: 60 });
    expect(service).toMatchObject({ name_ar: "صيانة ثلاجة", aliases: ["ثلاجة", "براد"], duration_min: 60, active: true });
    await create(s, "/v1/staff", { name_ar: "محمود", service_ids: [service.id] });
    expect(await times(s)).toHaveLength(17); // 09:00 … 17:00 every 30 minutes

    const edited = await call(s, "PATCH", `/v1/services/${service.id}`, { duration_min: 30 });
    expect(edited.json().data.duration_min).toBe(30);
    expect(await times(s, { service: "براد" })).toHaveLength(18); // 09:00 … 17:30

    expect((await call(s, "DELETE", `/v1/services/${service.id}`)).json().data.active).toBe(false);
    const gone = await call(s, "GET", "/v1/availability", undefined, { service: "ثلاجة" });
    expect(gone.json().error.code).toBe("SERVICE_NOT_FOUND");
    expect((await call(s, "GET", "/v1/services")).json().data.services).toHaveLength(0);
  });

  it("refuses a nonsense duration and a service that still has upcoming visits", async () => {
    const s = await shop(pool);
    expect((await call(s, "POST", "/v1/services", { name_ar: "x", duration_min: 2 })).json().error.code).toBe("INVALID_INPUT");
    expect((await call(s, "POST", "/v1/services", { name_ar: "x", duration_min: 1000 })).json().error.code).toBe("INVALID_INPUT");
    expect((await call(s, "POST", "/v1/services", { duration_min: 60 })).json().error.code).toBe("INVALID_INPUT");

    await book(s, "9");
    const r = await call(s, "DELETE", `/v1/services/${s.serviceId}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("HAS_UPCOMING_BOOKINGS");
  });
});

describe("zones", () => {
  it("keeps the visit fee with 3 decimals, can clear it, and exists only for businesses that go to customers", async () => {
    const s = await bareShop(pool);
    const zone = await create(s, "/v1/zones", { name_ar: "الهاشمي الشمالي", aliases: ["هاشمي"], visit_fee_jod: "7.5" });
    expect(zone.visit_fee_jod).toBe("7.500");

    expect((await call(s, "PATCH", `/v1/zones/${zone.id}`, { visit_fee_jod: 12 })).json().data.visit_fee_jod).toBe("12.000");
    expect((await call(s, "PATCH", `/v1/zones/${zone.id}`, { visit_fee_jod: null })).json().data.visit_fee_jod).toBeNull();
    expect((await call(s, "POST", "/v1/zones", { name_ar: "x", visit_fee_jod: -1 })).json().error.code).toBe("INVALID_INPUT");

    const clinic = await bareShop(pool, { goesToCustomer: false });
    const refused = await call(clinic, "POST", "/v1/zones", { name_ar: "عبدون" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("INVALID_INPUT");
  });

  it("is not deactivated while a visit there is still planned", async () => {
    const s = await shop(pool);
    const booking = await book(s, "9");
    expect((await call(s, "DELETE", `/v1/zones/${s.zoneId}`)).json().error.code).toBe("HAS_UPCOMING_BOOKINGS");
    await call(s, "POST", `/v1/bookings/${booking.id}/cancel`, {});
    expect((await call(s, "DELETE", `/v1/zones/${s.zoneId}`)).json().data.active).toBe(false);
  });
});

describe("days off", () => {
  it("takes whole days out of the calendar (local dates, inclusive) and gives them back when removed", async () => {
    const s = await shop(pool);
    const r = await call(s, "POST", "/v1/days-off", { date_from: "2026-11-08", date_to: "2026-11-08", reason: "عيد" });
    expect(r.statusCode).toBe(201);
    expect(r.json().data).toMatchObject({
      staff_id: null,
      start_at: "2026-11-07T21:00:00.000Z", // Sunday 00:00 Amman
      end_at: "2026-11-08T21:00:00.000Z", // Monday 00:00 Amman
      reason: "عيد",
    });
    expect(await times(s)).toEqual([]);
    expect((await times(s, { date_from: "2026-11-09", date_to: "2026-11-09" })).length).toBeGreaterThan(0);
    expect((await call(s, "GET", "/v1/days-off")).json().data.days_off).toHaveLength(1);

    expect((await call(s, "DELETE", `/v1/days-off/${r.json().data.id}`)).statusCode).toBe(200);
    expect((await times(s)).length).toBeGreaterThan(0);
    expect((await call(s, "DELETE", `/v1/days-off/${r.json().data.id}`)).statusCode).toBe(404);
  });

  it("can take out part of a day, or just one staff member", async () => {
    const s = await shop(pool);
    await call(s, "POST", "/v1/days-off", { start_at: "2026-11-08T07:00:00Z", end_at: "2026-11-08T09:00:00Z" }); // 10:00–12:00 Amman
    const partial = await times(s);
    expect(partial).toContain("09:00");
    expect(partial).toContain("12:00");
    for (const t of ["10:00", "11:00", "11:30"]) expect(partial).not.toContain(t);

    const t = await bareShop(pool);
    const service = await create(t, "/v1/services", { name_ar: "ثلاجة", aliases: ["ثلاجة"], duration_min: 60 });
    const first = await create(t, "/v1/staff", { name_ar: "محمود", service_ids: [service.id] });
    const second = await create(t, "/v1/staff", { name_ar: "سامر", service_ids: [service.id] });
    await call(t, "POST", "/v1/days-off", { staff_id: first.id, date_from: "2026-11-08", date_to: "2026-11-08" });
    const slots = (await call(t, "GET", "/v1/availability", undefined, { service: "ثلاجة", date_from: "2026-11-08", date_to: "2026-11-08", limit: "20" })).json().data.slots;
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map((x: { staff_id: string }) => x.staff_id))).toEqual(new Set([second.id]));
  });

  it("validates what it is given", async () => {
    const s = await shop(pool);
    const post = async (payload: Record<string, unknown>) => (await call(s, "POST", "/v1/days-off", payload)).json().error?.code;

    expect(await post({ date_from: "2026-11-10", date_to: "2026-11-08" })).toBe("INVALID_INPUT");
    expect(await post({ start_at: "2026-11-08T09:00:00Z", end_at: "2026-11-08T07:00:00Z" })).toBe("INVALID_INPUT");
    expect(await post({})).toBe("INVALID_INPUT");
    expect(await post({ date_from: "2026-11-08", date_to: "2026-11-08", start_at: "2026-11-08T07:00:00Z", end_at: "2026-11-08T09:00:00Z" })).toBe("INVALID_INPUT");
    expect(await post({ date_from: "2026-11-08", date_to: "2026-11-08", staff_id: "11111111-1111-4111-8111-111111111111" })).toBe("INVALID_INPUT");
  });
});

describe("business settings", () => {
  it("shows the effective rules and lets them be changed", async () => {
    const s = await shop(pool);
    const info = (await call(s, "GET", "/v1/business")).json().data;
    expect(info).toMatchObject({ timezone: "Asia/Amman", goes_to_customer: true });
    expect(info.settings).toEqual({
      slot_step_min: 30, gap_min: 30, min_lead_min: 120, horizon_days: 14, change_cutoff_min: 120, display_digits: "latin",
    });

    const r = await call(s, "PATCH", "/v1/business", { settings: { slot_step_min: 60, display_digits: "arabic" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.settings).toMatchObject({ slot_step_min: 60, gap_min: 30, display_digits: "arabic" });
    expect(await times(s)).toHaveLength(9); // hourly 09:00 … 17:00
  });

  it("refuses unknown settings, out-of-range values and an empty change", async () => {
    const s = await shop(pool);
    const patch = async (body: Record<string, unknown>) => (await call(s, "PATCH", "/v1/business", body)).json().error?.code;
    expect(await patch({ settings: { colour: "blue" } })).toBe("INVALID_INPUT");
    expect(await patch({ settings: { slot_step_min: 2 } })).toBe("INVALID_INPUT");
    expect(await patch({ settings: { display_digits: "roman" } })).toBe("INVALID_INPUT");
    expect(await patch({})).toBe("INVALID_INPUT");
    expect(await patch({ settings: {} })).toBe("INVALID_INPUT");
  });
});

describe("isolation and retries", () => {
  it("never lets one business see or change another's setup", async () => {
    const a = await shop(pool);
    const b = await shop(pool);
    const day = await create(a, "/v1/days-off", { date_from: "2026-11-09", date_to: "2026-11-09" });

    const attempts = [
      call(b, "GET", `/v1/staff/${a.staffId}`),
      call(b, "PATCH", `/v1/staff/${a.staffId}`, { name_ar: "x" }),
      call(b, "DELETE", `/v1/staff/${a.staffId}`),
      call(b, "PUT", `/v1/staff/${a.staffId}/hours`, { hours: [] }),
      call(b, "GET", `/v1/services/${a.serviceId}`),
      call(b, "PATCH", `/v1/services/${a.serviceId}`, { duration_min: 20 }),
      call(b, "DELETE", `/v1/services/${a.serviceId}`),
      call(b, "GET", `/v1/zones/${a.zoneId}`),
      call(b, "DELETE", `/v1/zones/${a.zoneId}`),
      call(b, "DELETE", `/v1/days-off/${day.id}`),
      call(b, "GET", "/v1/staff/not-an-id"),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("NOT_FOUND");
    }
    expect((await call(a, "GET", `/v1/staff/${a.staffId}`)).json().data.active).toBe(true);
    expect((await call(a, "GET", "/v1/days-off")).json().data.days_off).toHaveLength(1);
  });

  it("does not create a second staff member when the bot retries with the same Idempotency-Key", async () => {
    const s = await bareShop(pool);
    const send = () => call(s, "POST", "/v1/staff", { name_ar: "محمود" }, undefined, { "idempotency-key": "staff-1" });
    const first = await send();
    const retry = await send();

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().data.id).toBe(first.json().data.id);
    expect((await call(s, "GET", "/v1/staff")).json().data.staff).toHaveLength(1);
  });
});
