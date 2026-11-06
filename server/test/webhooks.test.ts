import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { cancelBooking } from "../src/bookings/manage.js";
import { deliverDue, startWebhookWorker } from "../src/webhooks/deliver.js";
import { BASE, PEPPER, SECRET, auth, customer, shop, type Shop } from "./fixtures.js";
import { testPool } from "./helpers.js";

const pool = testPool(10);
const clock = { now: BASE }; // Saturday 7 Nov 2026, 03:00 Amman; "tomorrow" = Sunday 8 Nov
let app: FastifyInstance;
let strictApp: FastifyInstance; // like production: https only, no private addresses

beforeAll(async () => {
  const base = { apiKeyPepper: PEPPER, slotTokenSecret: SECRET, now: () => clock.now };
  app = await buildApp(pool, { ...base, webhookAllowLocal: true });
  strictApp = await buildApp(pool, { ...base, webhookAllowLocal: false });
});
afterEach(() => {
  clock.now = BASE;
});
afterAll(async () => {
  await app.close();
  await strictApp.close();
  await pool.end();
});

// ---- a real HTTP receiver on localhost -----------------------------------------------------------------------
type Received = { headers: http.IncomingHttpHeaders; body: string };
async function startReceiver() {
  const received: Received[] = [];
  const mode: { kind: "reply" | "hang" | "redirect"; status: number } = { kind: "reply", status: 200 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      if (mode.kind === "hang") return; // never answers
      if (mode.kind === "redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
        return res.end();
      }
      res.writeHead(mode.status).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  const close = () => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { url, received, mode, close };
}
let receiver: Awaited<ReturnType<typeof startReceiver>>;
beforeEach(async () => {
  receiver = await startReceiver();
  await pool.query("DELETE FROM webhook_deliveries"); // events left over from other tests would be delivered too
});
afterEach(async () => {
  await receiver.close();
});

/** Verifies a delivery the way a receiver would, following the Standard Webhooks spec (independent of our code). */
function signatureIsValid(r: Received, secret: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = "v1," + createHmac("sha256", key).update(`${r.headers["webhook-id"]}.${r.headers["webhook-timestamp"]}.${r.body}`).digest("base64");
  return String(r.headers["webhook-signature"]).split(" ").includes(expected);
}

// ---- helpers ---------------------------------------------------------------------------------------------------
const call = (s: { key: string }, method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: auth(s.key), ...(payload && { payload }) });
const deliver = (extra: Record<string, unknown> = {}) => deliverDue(pool, { allowLocal: true, timeoutMs: 2000, ...extra });
const events = () => receiver.received.map((r) => JSON.parse(r.body));

/** Points the business's webhook at the receiver; returns the secret the business was given. */
async function subscribe(s: Shop) {
  const r = await call(s, "PATCH", "/v1/business", { webhook_url: receiver.url });
  expect(r.statusCode).toBe(200);
  return r.json().data.webhook_secret as string;
}
async function bookAt(s: Shop, time: string, extra: Record<string, unknown> = {}) {
  const found = (await call(s, "POST", "/v1/availability/check", { service: "ثلاجة", zone: "هاشمي شمالي", date: "بكرا", time })).json().data;
  const r = await call(s, "POST", "/v1/bookings", { slot_token: found.slot_token, ...customer, ...extra });
  if (r.statusCode !== 201) throw new Error(`test setup: booking failed ${r.body}`);
  return r.json().data as { id: string };
}
const deliveryRows = async (s: Shop) =>
  (await pool.query("SELECT id, event, status, attempt, last_error FROM webhook_deliveries WHERE business_id = $1 ORDER BY created_at, id", [s.businessId])).rows;
const makeDue = (s: Shop) =>
  pool.query("UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE business_id = $1 AND status = 'pending'", [s.businessId]);

describe("setting the webhook URL", () => {
  it("gives the business a secret, keeps it while the URL stays, and drops it when the URL is removed", async () => {
    const s = await shop(pool);
    expect((await call(s, "GET", "/v1/business")).json().data).toMatchObject({ webhook_url: null, webhook_secret: null });

    const first = (await call(s, "PATCH", "/v1/business", { webhook_url: receiver.url })).json().data;
    expect(first.webhook_url).toBe(receiver.url);
    expect(first.webhook_secret).toMatch(/^whsec_[A-Za-z0-9+/]{30,}={0,2}$/);
    expect(Buffer.from(first.webhook_secret.slice(6), "base64").length).toBeGreaterThanOrEqual(24);

    const changed = (await call(s, "PATCH", "/v1/business", { webhook_url: `${receiver.url}?v=2` })).json().data;
    expect(changed.webhook_secret).toBe(first.webhook_secret);
    expect((await call(s, "GET", "/v1/business")).json().data.webhook_secret).toBe(first.webhook_secret);

    const removed = (await call(s, "PATCH", "/v1/business", { webhook_url: null })).json().data;
    expect(removed).toMatchObject({ webhook_url: null, webhook_secret: null });
    const again = (await call(s, "PATCH", "/v1/business", { webhook_url: receiver.url })).json().data;
    expect(again.webhook_secret).not.toBe(first.webhook_secret); // removing and re-adding rotates the secret
  });

  it("only accepts https URLs to public hosts in production mode", async () => {
    const s = await shop(pool);
    const set = async (url: string) => strictApp.inject({ method: "PATCH", url: "/v1/business", headers: auth(s.key), payload: { webhook_url: url } });

    expect((await set("https://example.com/hooks/booking")).statusCode).toBe(200);
    for (const bad of [
      "http://example.com/hook", // not https
      "https://localhost/hook",
      "https://127.0.0.1/hook",
      "https://10.1.2.3/hook",
      "https://192.168.0.5/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://user:pass@example.com/hook", // credentials in the URL
      "ftp://example.com/hook",
      "not a url",
    ]) {
      const r = await set(bad);
      expect(r.statusCode, bad).toBe(422);
      expect(r.json().error.code).toBe("INVALID_INPUT");
    }
  });

  it("can be changed together with settings, and an empty change is refused", async () => {
    const s = await shop(pool);
    const both = await call(s, "PATCH", "/v1/business", { settings: { slot_step_min: 60 }, webhook_url: receiver.url });
    expect(both.json().data).toMatchObject({ webhook_url: receiver.url });
    expect(both.json().data.settings.slot_step_min).toBe(60);
    expect((await call(s, "PATCH", "/v1/business", {})).json().error.code).toBe("INVALID_INPUT");
  });
});

describe("what is sent", () => {
  it("delivers a signed booking.created with the customer text and template fields", async () => {
    const s = await shop(pool);
    const secret = await subscribe(s);
    const booking = await bookAt(s, "9");

    expect(await deliver()).toMatchObject({ delivered: 1, retried: 0, failed: 0 });
    expect(receiver.received).toHaveLength(1);
    const r = receiver.received[0]!;
    const evt = JSON.parse(r.body);

    expect(r.headers["content-type"]).toBe("application/json");
    expect(String(r.headers["webhook-id"])).toBe(`msg_${evt.id.slice("evt_".length)}`);
    expect(evt.id.startsWith("evt_")).toBe(true);
    expect(Math.abs(Number(r.headers["webhook-timestamp"]) - Date.now() / 1000)).toBeLessThan(30);
    expect(signatureIsValid(r, secret)).toBe(true);
    expect(signatureIsValid(r, "whsec_" + Buffer.from("some other secret!!").toString("base64"))).toBe(false);

    expect(evt).toMatchObject({ type: "booking.created", actor: "api" });
    expect(new Date(evt.created_at).getTime()).toBeGreaterThan(0);
    expect(evt.data.booking).toMatchObject({ id: booking.id, status: "confirmed", customer_phone: "+962795550100" });
    expect(evt.data.display_ar).toBe("تم تثبيت موعدك ✅ الأحد 8 تشرين الثاني الساعة 9 الصبح. إذا بدك تغيّر أو تلغي احكيلنا هون.");
    expect(evt.data.template).toEqual({
      customer_name: "سامر", date: "الأحد 8 تشرين الثاني", time: "الساعة 9 الصبح", zone: "الهاشمي الشمالي",
    });
    expect((await deliveryRows(s))[0]).toMatchObject({ event: "booking.created", status: "delivered", attempt: 1 });
  });

  it("reports every kind of change, in order, and nothing for no-ops", async () => {
    const s = await shop(pool);
    await subscribe(s);

    const a = await bookAt(s, "9");
    const later = (await call(s, "POST", "/v1/availability/check", { service: "ثلاجة", zone: "هاشمي شمالي", date: "بكرا", time: "10", booking_id: a.id })).json().data;
    await call(s, "POST", `/v1/bookings/${a.id}/reschedule`, { slot_token: later.slot_token });
    await call(s, "PATCH", `/v1/bookings/${a.id}`, { description: "ثلاجة LG" });
    await call(s, "PATCH", `/v1/bookings/${a.id}`, { description: "ثلاجة LG" }); // nothing changed: no event
    await call(s, "POST", `/v1/bookings/${a.id}/cancel`, { reason: "تغيّرت الخطة" });
    await call(s, "POST", `/v1/bookings/${a.id}/cancel`, {}); // already cancelled: no event
    const b = await bookAt(s, "12");
    await call(s, "POST", `/v1/bookings/${b.id}/status`, { status: "completed" });

    expect(await deliver()).toMatchObject({ delivered: 6 });
    const evts = events();
    expect(evts.map((e) => e.type)).toEqual([
      "booking.created", "booking.updated", "booking.updated", "booking.cancelled", "booking.created", "booking.updated",
    ]);
    expect(evts.map((e) => e.data.change)).toEqual([undefined, "rescheduled", "edited", undefined, undefined, "completed"]);

    expect(evts[1].data.previous).toMatchObject({ start_at: "2026-11-08T06:00:00.000Z" });
    expect(evts[1].data.booking.start_at).toBe("2026-11-08T07:00:00.000Z");
    expect(evts[1].data.display_ar).toBe("تم تغيير موعدك ✅ موعدك الجديد: الأحد 8 تشرين الثاني الساعة 10 الصبح.");
    expect(evts[2].data.display_ar).toBeNull(); // an edit of customer data is not a customer message
    expect(evts[3].data.reason).toBe("تغيّرت الخطة");
    expect(evts[3].data.display_ar).toBe("تم إلغاء موعدك ✅ إذا بدك تحجز موعد جديد احكيلنا.");
    expect(evts[5].data.display_ar).toBeNull();
    expect(new Set(evts.map((e) => e.actor))).toEqual(new Set(["api"]));
  });

  it("says who made the change, and tells the customer when the business cancelled", async () => {
    const s = await shop(pool);
    await subscribe(s);
    const booking = await bookAt(s, "9");
    await cancelBooking(pool, { businessId: s.businessId, bookingId: booking.id, reason: "الفني مريض", by: "business" });

    await deliver();
    const cancelled = events().find((e) => e.type === "booking.cancelled");
    expect(cancelled.actor).toBe("business");
    expect(cancelled.data.display_ar).toBe("للأسف اضطرينا نلغي موعدك 🙏 إذا بدك نرتبلك موعد ثاني احكيلنا.");
  });

  it("writes digits the way the business wants them", async () => {
    const s = await shop(pool);
    await subscribe(s);
    await call(s, "PATCH", "/v1/business", { settings: { display_digits: "arabic" } });
    await bookAt(s, "9");

    await deliver();
    const evt = events()[0];
    expect(evt.data.display_ar).toContain("الساعة ٩ الصبح");
    expect(evt.data.template.date).toBe("الأحد ٨ تشرين الثاني");
  });

  it("sends nothing for a business without a webhook, or for a booking that failed", async () => {
    const quiet = await shop(pool);
    await bookAt(quiet, "9");
    expect(await deliveryRows(quiet)).toEqual([]);

    const s = await shop(pool);
    await subscribe(s);
    const found = (await call(s, "POST", "/v1/availability/check", { service: "ثلاجة", zone: "هاشمي شمالي", date: "بكرا", time: "9" })).json().data;
    await call(s, "POST", "/v1/bookings", { slot_token: found.slot_token, ...customer });
    const again = await call(s, "POST", "/v1/bookings", { slot_token: found.slot_token, ...customer }); // SLOT_TAKEN
    expect(again.statusCode).toBe(409);
    expect(await deliveryRows(s)).toHaveLength(1);
  });
});

describe("when the receiver is down", () => {
  it("retries later with the same message id, and keeps trying only until it gets a 2xx", async () => {
    const s = await shop(pool);
    const secret = await subscribe(s);
    await bookAt(s, "9");

    receiver.mode.status = 500;
    expect(await deliver()).toMatchObject({ delivered: 0, retried: 1, failed: 0 });
    const [row] = await deliveryRows(s);
    expect(row).toMatchObject({ status: "pending", attempt: 1, last_error: "HTTP 500" });
    const { rows: [wait] } = await pool.query(
      "SELECT extract(epoch FROM next_attempt_at - now())::float AS s FROM webhook_deliveries WHERE business_id = $1", [s.businessId]);
    expect(wait.s).toBeGreaterThan(2); // first retry after about 5 seconds
    expect(wait.s).toBeLessThan(8);

    expect(await deliver()).toMatchObject({ delivered: 0, retried: 0 }); // not due yet
    expect(receiver.received).toHaveLength(1);

    receiver.mode.status = 200;
    await makeDue(s);
    expect(await deliver()).toMatchObject({ delivered: 1 });
    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[1]!.headers["webhook-id"]).toBe(receiver.received[0]!.headers["webhook-id"]);
    expect(receiver.received.every((r) => signatureIsValid(r, secret))).toBe(true);
    expect((await deliveryRows(s))[0]).toMatchObject({ status: "delivered", attempt: 2 });
  });

  it("gives up after 10 attempts", async () => {
    const s = await shop(pool);
    await subscribe(s);
    await bookAt(s, "9");

    receiver.mode.status = 503;
    for (let i = 0; i < 12; i++) {
      await makeDue(s);
      await deliver();
    }
    expect(receiver.received).toHaveLength(10);
    expect((await deliveryRows(s))[0]).toMatchObject({ status: "failed", attempt: 10, last_error: "HTTP 503" });
  });

  it("counts a redirect or a hanging receiver as a failure", async () => {
    const s = await shop(pool);
    await subscribe(s);
    await bookAt(s, "9");

    receiver.mode.kind = "redirect";
    await deliver();
    expect((await deliveryRows(s))[0]!.last_error).toBe("HTTP 302");

    receiver.mode.kind = "hang";
    await makeDue(s);
    await deliver({ timeoutMs: 200 });
    expect((await deliveryRows(s))[0]!.last_error).toContain("timeout");
    expect((await deliveryRows(s))[0]!.attempt).toBe(2);
  });

  it("fails clearly if the webhook was removed after the event was queued", async () => {
    const s = await shop(pool);
    await subscribe(s);
    await bookAt(s, "9");
    await call(s, "PATCH", "/v1/business", { webhook_url: null });

    expect(await deliver()).toMatchObject({ delivered: 0, failed: 1 });
    expect(receiver.received).toHaveLength(0);
    expect((await deliveryRows(s))[0]).toMatchObject({ status: "failed", last_error: "no webhook URL" });
  });

  it("refuses to call private addresses in production mode", async () => {
    const s = await shop(pool);
    await subscribe(s); // the receiver is on 127.0.0.1
    await bookAt(s, "9");

    await deliverDue(pool, { allowLocal: false, timeoutMs: 2000 });
    expect(receiver.received).toHaveLength(0);
    expect((await deliveryRows(s))[0]).toMatchObject({ status: "pending", attempt: 1 });
    expect((await deliveryRows(s))[0]!.last_error).toContain("blocked");
  });
});

describe("the background worker", () => {
  it("never sends the same event twice, even when two workers run at once", async () => {
    const s = await shop(pool);
    await subscribe(s);
    await bookAt(s, "9");

    await Promise.all([deliver(), deliver(), deliver()]);
    expect(receiver.received).toHaveLength(1);
  });

  it("delivers new events by itself", async () => {
    const s = await shop(pool);
    await subscribe(s);
    const worker = startWebhookWorker(pool, { allowLocal: true, intervalMs: 50, timeoutMs: 2000 });
    try {
      await bookAt(s, "9");
      for (let i = 0; i < 60 && receiver.received.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(receiver.received).toHaveLength(1);
      expect(JSON.parse(receiver.received[0]!.body).type).toBe("booking.created");
    } finally {
      await worker.stop();
    }
  });
});
