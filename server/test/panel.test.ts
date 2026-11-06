import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createAdmin } from "../src/auth/admins.js";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";
import { BASE, PEPPER, SECRET, auth, customer, shop, type Shop } from "./fixtures.js";
import { testPool } from "./helpers.js";

const pool = testPool(10);
const ms = { now: 5_000_000 }; // clock of the login throttle, in milliseconds
let app: FastifyInstance;
let throttled: FastifyInstance; // production login limits (5 per minute), with a controllable clock

beforeAll(async () => {
  await pool.query("TRUNCATE businesses CASCADE"); // the dashboard counts every business in the database
  const base = { apiKeyPepper: PEPPER, slotTokenSecret: SECRET, now: () => BASE };
  app = await buildApp(pool, { ...base, loginRateLimit: { perSecond: 1000, burst: 1000 } });
  throttled = await buildApp(pool, { ...base, loginRateLimit: { clock: () => ms.now } });
});
afterAll(async () => {
  await app.close();
  await throttled.close();
  await pool.end();
});

// ---- helpers ---------------------------------------------------------------------------------------------------
const PASSWORD = "correct horse battery";
const uniq = () => Math.random().toString(36).slice(2, 10);

async function newAdmin() {
  const username = `admin_${uniq()}`;
  await createAdmin(pool, username, PASSWORD, { cost: 10 });
  return username;
}
/** The "name=value" part of a Set-Cookie header. */
const cookieFrom = (res: { headers: Record<string, unknown> }, name: string) => {
  const raw = ([] as string[]).concat((res.headers["set-cookie"] as string | string[] | undefined) ?? []).find((c) => c.startsWith(`${name}=`));
  return raw ? raw.split(";")[0]! : null;
};
const send = (a: FastifyInstance, method: InjectOptions["method"], url: string, cookie: string | null, payload?: Record<string, unknown>, headers: Record<string, string> = {}) =>
  a.inject({ method, url, headers: { ...(cookie && { cookie }), ...headers }, ...(payload && { payload }) });

async function adminCookie() {
  const username = await newAdmin();
  const r = await send(app, "POST", "/panel/admin/login", null, { username, password: PASSWORD });
  expect(r.statusCode).toBe(200);
  return cookieFrom(r, "mawid_admin")!;
}
type Created = { id: string; api_key: string; username: string };
async function createBusiness(cookie: string, extra: Record<string, unknown> = {}): Promise<Created> {
  const username = `biz_${uniq()}`;
  const r = await send(app, "POST", "/panel/admin/businesses", cookie, {
    name: "مؤسسة النور", username, password: "temp-pass-123", goes_to_customer: true, staff_label_ar: "فني", staff_label_en: "Technician", ...extra,
  });
  if (r.statusCode !== 201) throw new Error(`create business failed: ${r.body}`);
  return { id: r.json().data.business.id, api_key: r.json().data.api_key, username };
}
const publicApi = (key: string, url: string, method: "GET" | "POST" = "GET", payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: auth(key), ...(payload && { payload }) });

describe("passwords", () => {
  it("stores a salted scrypt hash, never the password, and verifies it in any cost", async () => {
    const a = await hashPassword(PASSWORD, { cost: 10 });
    const b = await hashPassword(PASSWORD, { cost: 10 });
    expect(a.startsWith("scrypt$10$8$1$")).toBe(true);
    expect(a).not.toContain(PASSWORD);
    expect(a).not.toBe(b); // different salt each time
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword("wrong password", a)).toBe(false);
    expect(await verifyPassword(PASSWORD, "garbage")).toBe(false);
    expect((await hashPassword(PASSWORD)).startsWith("scrypt$15$")).toBe(true); // production cost
  });
});

describe("admin login", () => {
  it("opens a session in an HttpOnly, SameSite=Strict cookie and closes it on logout", async () => {
    const username = await newAdmin();
    const login = await send(app, "POST", "/panel/admin/login", null, { username, password: PASSWORD });
    expect(login.statusCode).toBe(200);
    expect(login.json().data).toEqual({ username });
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toMatch(/^mawid_admin=[A-Za-z0-9_-]{40,}/);
    for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=604800"]) expect(setCookie).toContain(flag);
    expect(setCookie).not.toContain("Secure"); // only when the server is told it is behind https

    const cookie = cookieFrom(login, "mawid_admin")!;
    expect((await send(app, "GET", "/panel/admin/me", cookie)).json().data).toEqual({ username });
    expect((await send(app, "POST", "/panel/admin/logout", cookie)).statusCode).toBe(200);
    expect((await send(app, "GET", "/panel/admin/me", cookie)).statusCode).toBe(401);
  });

  it("answers a wrong password and an unknown user in exactly the same way", async () => {
    const username = await newAdmin();
    const wrong = await send(app, "POST", "/panel/admin/login", null, { username, password: "nope-nope-nope" });
    const unknown = await send(app, "POST", "/panel/admin/login", null, { username: "nobody_here", password: "nope-nope-nope" });
    for (const r of [wrong, unknown]) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe("INVALID_CREDENTIALS");
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });

  it("refuses an expired session, a missing cookie, and the other panel's cookie", async () => {
    const cookie = await adminCookie();
    expect((await send(app, "GET", "/panel/admin/me", null)).statusCode).toBe(401);
    expect((await send(app, "GET", "/panel/admin/me", "mawid_admin=not-a-real-session")).statusCode).toBe(401);
    expect((await send(app, "GET", "/panel/admin/me", cookie.replace("mawid_admin", "mawid_app"))).statusCode).toBe(401);
    expect((await send(app, "GET", "/panel/app/me", cookie)).statusCode).toBe(401);

    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE kind = 'admin'");
    expect((await send(app, "GET", "/panel/admin/me", cookie)).statusCode).toBe(401);
  });

  it("rejects state-changing requests that come from another website", async () => {
    const cookie = await adminCookie();
    const evil = await send(app, "POST", "/panel/admin/logout", cookie, {}, { host: "panel.test", origin: "https://evil.example" });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe("FORBIDDEN");
    const own = await send(app, "POST", "/panel/admin/logout", cookie, {}, { host: "panel.test", origin: "http://panel.test" });
    expect(own.statusCode).toBe(200);
  });

  it("slows guessing down: 5 attempts a minute, then 429 even for the right password", async () => {
    const username = await newAdmin();
    for (let i = 0; i < 5; i++) {
      expect((await send(throttled, "POST", "/panel/admin/login", null, { username, password: `wrong-${i}-wrong` })).statusCode).toBe(401);
    }
    const blocked = await send(throttled, "POST", "/panel/admin/login", null, { username, password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    ms.now += 13_000; // one token is back
    expect((await send(throttled, "POST", "/panel/admin/login", null, { username, password: PASSWORD })).statusCode).toBe(200);
  });

  it("needs a session on every admin endpoint", async () => {
    const targets: [string, string][] = [
      ["GET", "/panel/admin/dashboard"], ["GET", "/panel/admin/businesses"], ["POST", "/panel/admin/businesses"],
      ["GET", "/panel/admin/businesses/x"], ["PATCH", "/panel/admin/businesses/x"], ["DELETE", "/panel/admin/businesses/x"],
      ["POST", "/panel/admin/businesses/x/api-key"], ["POST", "/panel/admin/businesses/x/password"],
      ["POST", "/panel/admin/businesses/x/reset-test-data"], ["POST", "/panel/admin/businesses/x/open"],
    ];
    for (const [method, url] of targets) {
      expect((await send(app, method as "GET", url, null)).statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("admin: businesses", () => {
  it("creates a business with its owner login and an API key that is shown once", async () => {
    const cookie = await adminCookie();
    const username = `biz_${uniq()}`;
    const r = await send(app, "POST", "/panel/admin/businesses", cookie, {
      name: "مؤسسة النور", username, password: "temp-pass-123", goes_to_customer: true, staff_label_ar: "فني", staff_label_en: "Technician",
    });
    expect(r.statusCode).toBe(201);
    const { business, api_key } = r.json().data;
    expect(api_key).toMatch(/^bk_live_[A-Za-z0-9_-]{30,}$/);
    expect(business).toMatchObject({
      name: "مؤسسة النور", username, active: true, is_test: false, goes_to_customer: true, must_change_password: true,
      staff_label_ar: "فني", staff_label_en: "Technician", api_key_last4: api_key.slice(-4), timezone: "Asia/Amman",
    });
    expect(r.body).not.toContain("scrypt$"); // no password hash in any answer

    // the key works on the public API, and is for exactly this business
    const info = await publicApi(api_key, "/v1/business");
    expect(info.statusCode).toBe(200);
    expect(info.json().data.name).toBe("مؤسسة النور");

    // afterwards only the last 4 characters can be seen
    const detail = await send(app, "GET", `/panel/admin/businesses/${business.id}`, cookie);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.api_key_last4).toBe(api_key.slice(-4));
    expect(detail.body).not.toContain(api_key);
    expect(detail.body).not.toContain("scrypt$");
  });

  it("refuses a taken username, a bad username and a short password", async () => {
    const cookie = await adminCookie();
    const first = await createBusiness(cookie);
    const bad = async (extra: Record<string, unknown>) => {
      const r = await send(app, "POST", "/panel/admin/businesses", cookie, { name: "x", username: `biz_${uniq()}`, password: "temp-pass-123", ...extra });
      return r.json().error?.code;
    };
    expect(await bad({ username: first.username })).toBe("INVALID_INPUT");
    expect(await bad({ username: "Has Space" })).toBe("INVALID_INPUT");
    expect(await bad({ username: "ab" })).toBe("INVALID_INPUT");
    expect(await bad({ password: "short" })).toBe("INVALID_INPUT");
    expect(await bad({ name: "" })).toBe("INVALID_INPUT");
  });

  it("makes a new key on request and the old one stops working at once", async () => {
    const cookie = await adminCookie();
    const biz = await createBusiness(cookie);
    const r = await send(app, "POST", `/panel/admin/businesses/${biz.id}/api-key`, cookie);
    expect(r.statusCode).toBe(200);
    const fresh = r.json().data.api_key as string;
    expect(fresh).not.toBe(biz.api_key);
    expect((await publicApi(biz.api_key, "/v1/business")).statusCode).toBe(401);
    expect((await publicApi(fresh, "/v1/business")).statusCode).toBe(200);
  });

  it("edits a business; switching it off stops its key and its login", async () => {
    const cookie = await adminCookie();
    const biz = await createBusiness(cookie);
    const edited = await send(app, "PATCH", `/panel/admin/businesses/${biz.id}`, cookie, { name: "مؤسسة الأمل", staff_label_ar: "حلاق", goes_to_customer: false });
    expect(edited.json().data).toMatchObject({ name: "مؤسسة الأمل", staff_label_ar: "حلاق", goes_to_customer: false });

    const off = await send(app, "PATCH", `/panel/admin/businesses/${biz.id}`, cookie, { active: false });
    expect(off.json().data.active).toBe(false);
    expect((await publicApi(biz.api_key, "/v1/business")).statusCode).toBe(401);
    const login = await send(app, "POST", "/panel/app/login", null, { username: biz.username, password: "temp-pass-123" });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe("ACCOUNT_DISABLED");

    await send(app, "PATCH", `/panel/admin/businesses/${biz.id}`, cookie, { active: true });
    expect((await publicApi(biz.api_key, "/v1/business")).statusCode).toBe(200);
  });

  it("sets the webhook URL with the same rules as the API", async () => {
    const cookie = await adminCookie();
    const biz = await createBusiness(cookie);
    const ok = await send(app, "PATCH", `/panel/admin/businesses/${biz.id}`, cookie, { webhook_url: "https://example.com/hooks/booking" });
    expect(ok.json().data.webhook_url).toBe("https://example.com/hooks/booking");
    expect(ok.json().data.webhook_secret).toMatch(/^whsec_/);
    const bad = await send(app, "PATCH", `/panel/admin/businesses/${biz.id}`, cookie, { webhook_url: "http://example.com/hook" });
    expect(bad.statusCode).toBe(422);
  });

  it("resets the owner's password: new temporary password, forced change, old sessions closed", async () => {
    const cookie = await adminCookie();
    const biz = await createBusiness(cookie);
    const owner = await send(app, "POST", "/panel/app/login", null, { username: biz.username, password: "temp-pass-123" });
    const ownerCookie = cookieFrom(owner, "mawid_app")!;
    expect((await send(app, "GET", "/panel/app/me", ownerCookie)).statusCode).toBe(200);

    const r = await send(app, "POST", `/panel/admin/businesses/${biz.id}/password`, cookie, { password: "another-temp-456" });
    expect(r.statusCode).toBe(200);
    expect((await send(app, "GET", "/panel/app/me", ownerCookie)).statusCode).toBe(401);
    expect((await send(app, "POST", "/panel/app/login", null, { username: biz.username, password: "temp-pass-123" })).statusCode).toBe(401);
    const again = await send(app, "POST", "/panel/app/login", null, { username: biz.username, password: "another-temp-456" });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.must_change_password).toBe(true);
  });

  it("deletes a business only when its name is typed again, with everything that belongs to it", async () => {
    const cookie = await adminCookie();
    const biz = await createBusiness(cookie, { name: "مؤسسة للحذف" });
    await publicApi(biz.api_key, "/v1/services", "POST", { name_ar: "صيانة", duration_min: 60 });

    const refused = await send(app, "DELETE", `/panel/admin/businesses/${biz.id}`, cookie, { confirm_name: "something else" });
    expect(refused.statusCode).toBe(422);
    expect((await send(app, "GET", `/panel/admin/businesses/${biz.id}`, cookie)).statusCode).toBe(200);

    const done = await send(app, "DELETE", `/panel/admin/businesses/${biz.id}`, cookie, { confirm_name: "مؤسسة للحذف" });
    expect(done.statusCode).toBe(200);
    expect((await send(app, "GET", `/panel/admin/businesses/${biz.id}`, cookie)).statusCode).toBe(404);
    expect((await publicApi(biz.api_key, "/v1/business")).statusCode).toBe(401);
    expect((await pool.query("SELECT count(*)::int AS n FROM services WHERE business_id = $1", [biz.id])).rows[0].n).toBe(0);
  });

  it("gives a test business sample data (3 technicians, Amman zones) and can reset it", async () => {
    const cookie = await adminCookie();
    const biz = await createBusiness(cookie, { name: "Demo Repair", is_test: true });
    expect(biz.api_key.startsWith("bk_test_")).toBe(true);

    const staff = (await publicApi(biz.api_key, "/v1/staff")).json().data.staff;
    expect(staff).toHaveLength(3);
    expect((await publicApi(biz.api_key, "/v1/zones")).json().data.zones).toHaveLength(8);
    const found = await publicApi(biz.api_key, "/v1/availability?service=%D8%AB%D9%84%D8%A7%D8%AC%D8%A9&zone=%D9%87%D8%A7%D8%B4%D9%85%D9%8A%20%D8%B4%D9%85%D8%A7%D9%84%D9%8A&date_from=2026-11-08&date_to=2026-11-08");
    expect(found.json().data.slots.length).toBeGreaterThan(0);

    await publicApi(biz.api_key, "/v1/bookings", "POST", { slot_token: found.json().data.slots[0].slot_token, ...customer });
    const reset = await send(app, "POST", `/panel/admin/businesses/${biz.id}/reset-test-data`, cookie);
    expect(reset.statusCode).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM bookings WHERE business_id = $1", [biz.id])).rows[0].n).toBe(0);
    const after = (await publicApi(biz.api_key, "/v1/staff")).json().data.staff;
    expect(after).toHaveLength(3);
    expect(after[0].id).not.toBe(staff[0].id); // a fresh set

    const real = await createBusiness(cookie);
    const refused = await send(app, "POST", `/panel/admin/businesses/${real.id}/reset-test-data`, cookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("FORBIDDEN");
  });

  it("answers 404 for an unknown business", async () => {
    const cookie = await adminCookie();
    for (const id of ["11111111-1111-4111-8111-111111111111", "not-an-id"]) {
      expect((await send(app, "GET", `/panel/admin/businesses/${id}`, cookie)).statusCode).toBe(404);
      expect((await send(app, "POST", `/panel/admin/businesses/${id}/api-key`, cookie)).statusCode).toBe(404);
    }
  });
});

describe("admin: dashboard", () => {
  async function bookAt(s: Shop, time: string) {
    const found = (await app.inject({ method: "POST", url: "/v1/availability/check", headers: auth(s.key), payload: { service: "ثلاجة", zone: "هاشمي شمالي", date: "بكرا", time } })).json().data;
    const r = await app.inject({ method: "POST", url: "/v1/bookings", headers: auth(s.key), payload: { slot_token: found.slot_token, ...customer } });
    return r.json().data.id as string;
  }
  const setCreated = (id: string, iso: string) => pool.query("UPDATE bookings SET created_at = $2 WHERE id = $1", [id, iso]);

  it("counts bookings by the month they were made (Amman time), by status, without test businesses", async () => {
    await pool.query("TRUNCATE businesses CASCADE");
    const cookie = await adminCookie();
    const a = await shop(pool);
    const b = await shop(pool);
    const t = await shop(pool);
    await pool.query("UPDATE businesses SET is_test = true WHERE id = $1", [t.businessId]);

    const a1 = await bookAt(a, "9"); // confirmed, made 3 Nov
    const a2 = await bookAt(a, "12"); // cancelled, made 3 Nov
    const a3 = await bookAt(a, "3"); // made 31 Oct 20:59 UTC = 23:59 in Amman: October
    const b1 = await bookAt(b, "9"); // completed, made 31 Oct 21:00 UTC = 00:00 on 1 Nov in Amman: November
    const t1 = await bookAt(t, "9"); // a test business
    await app.inject({ method: "POST", url: `/v1/bookings/${a2}/cancel`, headers: auth(a.key), payload: {} });
    await app.inject({ method: "POST", url: `/v1/bookings/${b1}/status`, headers: auth(b.key), payload: { status: "completed" } });
    await setCreated(a1, "2026-11-03T10:00:00Z");
    await setCreated(a2, "2026-11-03T11:00:00Z");
    await setCreated(a3, "2026-10-31T20:59:00Z");
    await setCreated(b1, "2026-10-31T21:00:00Z");
    await setCreated(t1, "2026-11-03T10:00:00Z");

    const r = await send(app, "GET", "/panel/admin/dashboard?month=2026-11", cookie);
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.month).toBe("2026-11");
    expect(d.businesses_total).toBe(2);
    expect(d.totals).toEqual({ total: 3, confirmed: 1, cancelled: 1, completed: 1, no_show: 0 });
    const row = (id: string) => d.businesses.find((x: { id: string }) => x.id === id);
    expect(row(a.businessId)).toMatchObject({ total: 2, confirmed: 1, cancelled: 1, completed: 0 });
    expect(row(b.businessId)).toMatchObject({ total: 1, confirmed: 0, completed: 1 });
    expect(row(t.businessId)).toBeUndefined();

    const october = (await send(app, "GET", "/panel/admin/dashboard?month=2026-10", cookie)).json().data;
    expect(october.totals.total).toBe(1);
    const now = (await send(app, "GET", "/panel/admin/dashboard", cookie)).json().data; // defaults to the current month
    expect(now.month).toBe("2026-11");
    expect((await send(app, "GET", "/panel/admin/dashboard?month=2026-13", cookie)).statusCode).toBe(422);

    const list = (await send(app, "GET", "/panel/admin/businesses?month=2026-11", cookie)).json().data.businesses;
    expect(list).toHaveLength(3); // the list shows test businesses too, marked
    expect(list.find((x: { id: string }) => x.id === t.businessId)).toMatchObject({ is_test: true, total: 1 });
  });
});
