import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { BASE, PEPPER, SECRET, auth } from "./fixtures.js";
import { OWNER_PASSWORD, TEMP_PASSWORD, cookieFrom, panelClient } from "./panelFixtures.js";
import { testPool } from "./helpers.js";

const pool = testPool(10);
let app: FastifyInstance;
let p: ReturnType<typeof panelClient>;

beforeAll(async () => {
  app = await buildApp(pool, { apiKeyPepper: PEPPER, slotTokenSecret: SECRET, now: () => BASE, loginRateLimit: { perSecond: 1000, burst: 1000 } });
  p = panelClient(app, pool);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const SUNDAY_09 = "2026-11-08T06:00:00Z"; // 09:00 in Amman
const historyOf = async (cookie: string, id: string) => (await p.send("GET", `/panel/app/bookings/${id}`, cookie)).json().data.history as { action: string; by: string }[];
const queuedActors = async (businessId: string) =>
  (await pool.query("SELECT payload->>'actor' AS actor, event FROM webhook_deliveries WHERE business_id = $1 ORDER BY created_at, id", [businessId])).rows;

describe("owner login", () => {
  it("must replace the temporary password before anything else", async () => {
    const o = await p.owner({}, { changePassword: false });
    const blocked = await p.send("GET", "/panel/app/calendar", o.cookie, undefined, { from: "2026-11-08", to: "2026-11-08" });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await p.send("GET", "/panel/app/me", o.cookie)).json().data.must_change_password).toBe(true);

    expect((await p.send("POST", "/panel/app/password", o.cookie, { current_password: "wrong-password", new_password: OWNER_PASSWORD })).json().error.code).toBe("INVALID_CREDENTIALS");
    expect((await p.send("POST", "/panel/app/password", o.cookie, { current_password: TEMP_PASSWORD, new_password: "short" })).json().error.code).toBe("INVALID_INPUT");
    expect((await p.send("POST", "/panel/app/password", o.cookie, { current_password: TEMP_PASSWORD, new_password: TEMP_PASSWORD })).json().error.code).toBe("INVALID_INPUT");

    const changed = await p.send("POST", "/panel/app/password", o.cookie, { current_password: TEMP_PASSWORD, new_password: OWNER_PASSWORD });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data.must_change_password).toBe(false);
    expect((await p.send("GET", "/panel/app/calendar", o.cookie, undefined, { from: "2026-11-08", to: "2026-11-08" })).statusCode).toBe(200);

    expect((await p.send("POST", "/panel/app/login", null, { username: o.username, password: TEMP_PASSWORD })).statusCode).toBe(401);
    expect((await p.send("POST", "/panel/app/login", null, { username: o.username, password: OWNER_PASSWORD })).statusCode).toBe(200);
  });

  it("closes the owner's other logins when the password changes, and logs out", async () => {
    const o = await p.owner();
    const second = cookieFrom(await p.send("POST", "/panel/app/login", null, { username: o.username, password: OWNER_PASSWORD }), "mawid_app")!;
    expect((await p.send("GET", "/panel/app/me", second)).statusCode).toBe(200);

    await p.send("POST", "/panel/app/password", o.cookie, { current_password: OWNER_PASSWORD, new_password: "yet-another-pass-2" });
    expect((await p.send("GET", "/panel/app/me", second)).statusCode).toBe(401);
    expect((await p.send("GET", "/panel/app/me", o.cookie)).statusCode).toBe(200);

    expect((await p.send("POST", "/panel/app/logout", o.cookie)).statusCode).toBe(200);
    expect((await p.send("GET", "/panel/app/me", o.cookie)).statusCode).toBe(401);
  });
});

describe("calendar", () => {
  it("shows a day's bookings with names, plus staff, services, zones and days off", async () => {
    const o = await p.owner();
    await p.botBooking(o.key, "9", { description: "ثلاجة LG — ما بتبرد" });
    await p.botBooking(o.key, "12");
    await p.send("POST", "/panel/app/days-off", o.cookie, { date_from: "2026-11-09", date_to: "2026-11-09", reason: "عيد" });

    const r = await p.send("GET", "/panel/app/calendar", o.cookie, undefined, { from: "2026-11-08", to: "2026-11-09" });
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.timezone).toBe("Asia/Amman");
    expect(d.bookings.map((b: { start_at: string }) => b.start_at)).toEqual(["2026-11-08T06:00:00.000Z", "2026-11-08T09:00:00.000Z"]);
    expect(d.bookings[0]).toMatchObject({
      status: "confirmed", customer_phone: "+962795550100", description: "ثلاجة LG — ما بتبرد", service_name_ar: "صيانة ثلاجة",
      zone_name_ar: "الهاشمي الشمالي", staff_name_ar: expect.any(String),
    });
    expect(d.staff).toHaveLength(3);
    expect(d.services).toHaveLength(5);
    expect(d.zones).toHaveLength(8);
    expect(d.days_off).toHaveLength(1);
    expect(d.days_off[0].reason).toBe("عيد");
  });

  it("only shows the owner's own bookings, and validates the range", async () => {
    const a = await p.owner();
    const b = await p.owner();
    await p.botBooking(a.key, "9");
    const mine = (await p.send("GET", "/panel/app/calendar", b.cookie, undefined, { from: "2026-11-08", to: "2026-11-08" })).json().data;
    expect(mine.bookings).toEqual([]);

    const bad = (query: Record<string, string>) => p.send("GET", "/panel/app/calendar", b.cookie, undefined, query);
    expect((await bad({ from: "2026-11-09", to: "2026-11-08" })).json().error.code).toBe("INVALID_INPUT");
    expect((await bad({ from: "2026-11-01", to: "2027-01-31" })).json().error.code).toBe("INVALID_INPUT"); // more than 62 days
    expect((await bad({ from: "2026-11-01" })).json().error.code).toBe("INVALID_INPUT");
  });

  it("offers every free time for a manual booking, with the staff member for each", async () => {
    const o = await p.owner();
    const cal = (await p.send("GET", "/panel/app/calendar", o.cookie, undefined, { from: "2026-11-08", to: "2026-11-08" })).json().data;
    const fridge = cal.services.find((s: { name_ar: string }) => s.name_ar === "صيانة ثلاجة");

    const r = await p.send("GET", "/panel/app/slots", o.cookie, undefined, { service_id: fridge.id, date_from: "2026-11-08", date_to: "2026-11-08" });
    expect(r.statusCode).toBe(200);
    const slots = r.json().data.slots;
    expect(slots).toHaveLength(17); // 09:00 … 17:00 every 30 minutes, one entry per time
    expect(slots[0]).toMatchObject({ local_time: "09:00", start_at: SUNDAY_09.replace("Z", ".000Z"), staff_name_ar: expect.any(String) });

    expect((await p.send("GET", "/panel/app/slots", o.cookie, undefined, { service_id: "11111111-1111-4111-8111-111111111111", date_from: "2026-11-08", date_to: "2026-11-08" })).json().error.code).toBe("SERVICE_NOT_FOUND");
  });
});

describe("bookings made in the panel", () => {
  async function setup() {
    const o = await p.owner();
    const cal = (await p.send("GET", "/panel/app/calendar", o.cookie, undefined, { from: "2026-11-08", to: "2026-11-08" })).json().data;
    return {
      ...o,
      serviceId: cal.services.find((s: { name_ar: string }) => s.name_ar === "صيانة ثلاجة").id as string,
      zoneId: cal.zones[0].id as string,
      staff: cal.staff as { id: string }[],
    };
  }
  const body = (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) => ({
    service_id: s.serviceId, zone_id: s.zoneId, staff_id: s.staff[0]!.id, start_at: SUNDAY_09,
    customer_name: "ليث", customer_phone: "0791234567", description: "فرن لا يشتغل", ...extra,
  });

  it("creates a booking, recorded as made by the business, and refuses a taken time", async () => {
    const s = await setup();
    const r = await p.send("POST", "/panel/app/bookings", s.cookie, body(s));
    expect(r.statusCode).toBe(201);
    expect(r.json().data).toMatchObject({
      status: "confirmed", source: "panel", customer_phone: "+962791234567", start_at: "2026-11-08T06:00:00.000Z", staff_id: s.staff[0]!.id, visit_fee_jod: expect.any(String),
    });
    expect(await historyOf(s.cookie, r.json().data.id)).toMatchObject([{ action: "created", by: "business" }]);

    const clash = await p.send("POST", "/panel/app/bookings", s.cookie, body(s, { customer_name: "سامي" }));
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("SLOT_TAKEN");
  });

  it("refuses a bad phone and references that belong to another business", async () => {
    const s = await setup();
    const other = await setup();
    const code = async (extra: Record<string, unknown>) => (await p.send("POST", "/panel/app/bookings", s.cookie, body(s, extra))).json().error.code;

    expect(await code({ customer_phone: "123" })).toBe("INVALID_PHONE");
    expect(await code({ customer_name: "" })).toBe("INVALID_INPUT");
    expect(await code({ zone_id: other.zoneId })).toBe("INVALID_INPUT");
    expect(await code({ staff_id: other.staff[0]!.id })).toBe("NOT_FOUND");
    expect(await code({ service_id: other.serviceId })).toBe("NOT_FOUND");
  });

  it("moves, edits, finishes and cancels without the 2-hour limit the API has", async () => {
    const s = await setup();
    // a visit one hour from "now" (the test clock is 03:00 Amman on Saturday 7 Nov)
    const soon = (await p.send("POST", "/panel/app/bookings", s.cookie, body(s, { start_at: "2026-11-07T01:00:00Z" }))).json().data;

    const viaApi = await app.inject({ method: "POST", url: `/v1/bookings/${soon.id}/cancel`, headers: auth(s.key), payload: {} });
    expect(viaApi.json().error.code).toBe("TOO_LATE_TO_CHANGE");

    const moved = await p.send("POST", `/panel/app/bookings/${soon.id}/reschedule`, s.cookie, { staff_id: s.staff[1]!.id, start_at: "2026-11-08T08:00:00Z" });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().data).toMatchObject({ staff_id: s.staff[1]!.id, start_at: "2026-11-08T08:00:00.000Z" });

    const edited = await p.send("PATCH", `/panel/app/bookings/${soon.id}`, s.cookie, { description: "تعديل", customer_phone: "٠٧٩٩٨٧٦٥٤٣" });
    expect(edited.json().data).toMatchObject({ description: "تعديل", customer_phone: "+962799876543" });

    const done = await p.send("POST", `/panel/app/bookings/${soon.id}/status`, s.cookie, { status: "completed" });
    expect(done.json().data.status).toBe("completed");

    const other = (await p.send("POST", "/panel/app/bookings", s.cookie, body(s, { start_at: "2026-11-07T01:00:00Z", customer_name: "نور" }))).json().data;
    const cancelled = await p.send("POST", `/panel/app/bookings/${other.id}/cancel`, s.cookie, { reason: "طلب الزبون" });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data.status).toBe("cancelled");

    expect((await historyOf(s.cookie, soon.id)).map((h) => `${h.action}:${h.by}`)).toEqual([
      "created:business", "rescheduled:business", "updated:business", "status_changed:business",
    ]);
  });

  it("refuses to move a booking onto a taken time or to another business's staff", async () => {
    const s = await setup();
    const other = await setup();
    const a = (await p.send("POST", "/panel/app/bookings", s.cookie, body(s))).json().data;
    const b = (await p.send("POST", "/panel/app/bookings", s.cookie, body(s, { start_at: "2026-11-08T09:00:00Z", customer_name: "سامي" }))).json().data;

    const clash = await p.send("POST", `/panel/app/bookings/${b.id}/reschedule`, s.cookie, { staff_id: s.staff[0]!.id, start_at: SUNDAY_09 });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("SLOT_TAKEN");
    const foreign = await p.send("POST", `/panel/app/bookings/${b.id}/reschedule`, s.cookie, { staff_id: other.staff[0]!.id, start_at: "2026-11-08T10:00:00Z" });
    expect(foreign.json().error.code).toBe("INVALID_INPUT");
    expect(a.id).not.toBe(b.id);
  });

  it("finds bookings by phone or reference, and keeps businesses apart", async () => {
    const s = await setup();
    const other = await setup();
    await p.send("POST", "/panel/app/bookings", s.cookie, body(s, { external_ref: "SR-7" }));
    await p.send("POST", "/panel/app/bookings", other.cookie, body(other, { external_ref: "SR-7" }));

    const byPhone = await p.send("GET", "/panel/app/bookings", s.cookie, undefined, { phone: "٠٧٩١٢٣٤٥٦٧" });
    expect(byPhone.json().data.bookings).toHaveLength(1);
    expect((await p.send("GET", "/panel/app/bookings", s.cookie, undefined, { external_ref: "SR-7" })).json().data.bookings).toHaveLength(1);
    expect((await p.send("GET", "/panel/app/bookings", s.cookie, undefined, { phone: "123" })).json().error.code).toBe("INVALID_PHONE");

    const id = byPhone.json().data.bookings[0].id;
    expect((await p.send("GET", `/panel/app/bookings/${id}`, other.cookie)).statusCode).toBe(404);
    expect((await p.send("POST", `/panel/app/bookings/${id}/cancel`, other.cookie, {})).statusCode).toBe(404);
  });
});

describe("setup from the panel", () => {
  it("lets the owner manage staff, services, zones and settings, but not the webhook", async () => {
    const o = await p.owner({ is_test: false });
    const svc = await p.send("POST", "/panel/app/services", o.cookie, { name_ar: "صيانة ثلاجة", aliases: ["ثلاجة"], duration_min: 60 });
    expect(svc.statusCode).toBe(201);
    const staff = await p.send("POST", "/panel/app/staff", o.cookie, { name_ar: "محمود", service_ids: [svc.json().data.id] });
    expect(staff.statusCode).toBe(201);
    expect((await p.send("GET", "/panel/app/staff", o.cookie)).json().data.staff).toHaveLength(1);

    const settings = await p.send("PATCH", "/panel/app/business", o.cookie, { settings: { slot_step_min: 60 } });
    expect(settings.json().data.settings.slot_step_min).toBe(60);
    expect(settings.body).not.toContain("webhook");

    const hook = await p.send("PATCH", "/panel/app/business", o.cookie, { webhook_url: "https://example.com/hook" });
    expect(hook.statusCode).toBe(403);
    expect(hook.json().error.code).toBe("FORBIDDEN");
  });

  it("needs a session on every business-panel endpoint", async () => {
    const targets: [string, string][] = [
      ["GET", "/panel/app/me"], ["GET", "/panel/app/calendar"], ["GET", "/panel/app/slots"], ["GET", "/panel/app/bookings"],
      ["POST", "/panel/app/bookings"], ["GET", "/panel/app/staff"], ["GET", "/panel/app/services"], ["GET", "/panel/app/zones"],
      ["GET", "/panel/app/days-off"], ["GET", "/panel/app/business"], ["PATCH", "/panel/app/business"],
    ];
    for (const [method, url] of targets) {
      expect((await p.send(method as "GET", url, null)).statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("the admin opens a business's calendar", () => {
  it("gets full control, skips the password change, and everything is recorded as made by the admin", async () => {
    const o = await p.owner({}, { changePassword: false }); // the owner never replaced the temporary password
    const booking = await p.botBooking(o.key, "9");
    await p.send("PATCH", `/panel/admin/businesses/${o.businessId}`, o.admin, { webhook_url: "https://example.com/hook" });

    const opened = await p.send("POST", `/panel/admin/businesses/${o.businessId}/open`, o.admin);
    expect(opened.statusCode).toBe(200);
    const adminAsOwner = cookieFrom(opened, "mawid_app")!;

    expect((await p.send("GET", "/panel/app/me", adminAsOwner)).json().data).toMatchObject({ by_admin: true, name: "مؤسسة النور" });
    const cal = await p.send("GET", "/panel/app/calendar", adminAsOwner, undefined, { from: "2026-11-08", to: "2026-11-08" });
    expect(cal.statusCode).toBe(200);
    expect(cal.json().data.bookings).toHaveLength(1);

    expect((await p.send("POST", `/panel/app/bookings/${booking.id}/cancel`, adminAsOwner, { reason: "من الإدارة" })).statusCode).toBe(200);
    expect((await historyOf(adminAsOwner, booking.id)).at(-1)).toMatchObject({ action: "cancelled", by: "admin" });
    expect((await queuedActors(o.businessId)).at(-1)).toMatchObject({ event: "booking.cancelled", actor: "admin" });

    const pw = await p.send("POST", "/panel/app/password", adminAsOwner, { current_password: "x", new_password: "whatever-123" });
    expect(pw.statusCode).toBe(403);
  });

  it("works even when the business is switched off, while the owner is locked out", async () => {
    const o = await p.owner();
    await p.send("PATCH", `/panel/admin/businesses/${o.businessId}`, o.admin, { active: false });
    expect((await p.send("GET", "/panel/app/me", o.cookie)).statusCode).toBe(401); // the owner's session was closed

    const opened = await p.send("POST", `/panel/admin/businesses/${o.businessId}/open`, o.admin);
    expect((await p.send("GET", "/panel/app/me", cookieFrom(opened, "mawid_app")!)).statusCode).toBe(200);
  });

  it("records the owner's own changes as made by the business", async () => {
    const o = await p.owner();
    const booking = await p.botBooking(o.key, "9");
    await p.send("PATCH", `/panel/admin/businesses/${o.businessId}`, o.admin, { webhook_url: "https://example.com/hook" });
    await p.send("POST", `/panel/app/bookings/${booking.id}/cancel`, o.cookie, {});
    expect((await queuedActors(o.businessId)).at(-1)).toMatchObject({ event: "booking.cancelled", actor: "business" });
  });
});
