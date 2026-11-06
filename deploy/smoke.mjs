// End-to-end check of a running server, the way a real client would use it. Prints no secrets.
//   BASE_URL=https://api.example.com ADMIN_USER=admin ADMIN_PASSWORD=... node deploy/smoke.mjs
// It creates a TEST business, books and cancels through the public API and the panel, then deletes the business again.
const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const adminUser = process.env.ADMIN_USER;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!base || !adminUser || !adminPassword) {
  console.error("Set BASE_URL, ADMIN_USER and ADMIN_PASSWORD.");
  process.exit(2);
}

let failures = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const jar = new Map();
async function call(method, path, { body, key, cookie } = {}) {
  const headers = { ...(body && { "content-type": "application/json" }), ...(key && { authorization: `Bearer ${key}` }) };
  if (cookie) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body), redirect: "manual" });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json (a page) */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const oneLine = (text) => String(text ?? "").replaceAll("\n", " | ");

// 1. the front door
const health = await call("GET", "/health");
check(health.status === 200 && health.json?.ok === true, "GET /health");
const docs = await call("GET", "/docs/openapi.json");
check(docs.status === 200 && docs.json?.openapi === "3.1.0", "GET /docs/openapi.json", `(${Object.keys(docs.json?.paths ?? {}).length} paths)`);
check((await call("GET", "/docs/guide/ar")).status === 200, "GET /docs/guide/ar");
check((await call("GET", "/docs/guide/en")).status === 200, "GET /docs/guide/en");
const appPage = await call("GET", "/app/team");
check(appPage.status === 200 && appPage.text.includes('<div id="root">'), "the Business Panel page (also a deep link)");
check((await call("GET", "/admin/login")).text.includes('<div id="root">'), "the Admin Panel page");
check((await call("GET", "/")).status === 302, "/ goes to the Business Panel");
check((await call("GET", "/v1/business")).status === 401, "the API refuses a request without a key (401)");
const wrong = await call("POST", "/panel/admin/login", { body: { username: adminUser, password: "definitely-not-the-password" } });
check(wrong.status === 401, "the admin login refuses a wrong password (401)");
if (base.startsWith("https://")) check(true, "served over https");

// 2. admin: make a test business
const login = await call("POST", "/panel/admin/login", { body: { username: adminUser, password: adminPassword } });
check(login.status === 200, "admin login");
if (login.status !== 200) process.exit(1);
const name = `Smoke test ${Date.now()}`;
const created = await call("POST", "/panel/admin/businesses", {
  cookie: true,
  body: { name, username: `smoke_${Date.now()}`, password: "temp-pass-12345", goes_to_customer: true, is_test: true },
});
check(created.status === 201 && created.json?.data?.api_key?.startsWith("bk_test_"), "create a test business with sample data");
const businessId = created.json?.data?.business?.id;
const key = created.json?.data?.api_key;
const dashboard = await call("GET", "/panel/admin/dashboard", { cookie: true });
check(dashboard.status === 200 && typeof dashboard.json?.data?.businesses_total === "number", "admin dashboard");

try {
  // 3. the bot flow through the public API
  const staff = await call("GET", "/v1/staff", { key });
  check(staff.status === 200 && staff.json.data.staff.length === 3, "the test business has 3 technicians");

  const day = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
  const query = `service=${encodeURIComponent("ثلاجة")}&zone=${encodeURIComponent("هاشمي شمالي")}&date_from=${day}`;
  const av = await call("GET", `/v1/availability?${query}`, { key });
  const slots = av.json?.data?.slots ?? [];
  check(av.status === 200 && slots.length > 0, "free times found", oneLine(av.json?.display_ar));

  const booked = await call("POST", "/v1/bookings", {
    key,
    body: { slot_token: slots[0]?.slot_token, customer_name: "سامر", customer_phone: "0795550100", external_ref: "SR-SMOKE-1" },
  });
  check(booked.status === 201, "booking created", oneLine(booked.json?.display_ar ?? booked.text.slice(0, 120)));
  const id = booked.json?.data?.id;

  // 3 technicians: the same time can be given to 3 different people, and the 4th request has nobody left
  const more = [];
  for (const [name, phone] of [["ليث", "0791234567"], ["سامي", "0771234567"], ["نور", "0751234567"]]) {
    more.push(await call("POST", "/v1/bookings", { key, body: { slot_token: slots[0]?.slot_token, customer_name: name, customer_phone: phone } }));
  }
  const staffIds = [booked, ...more.slice(0, 2)].map((r) => r.json?.data?.staff_id);
  check(more[0].status === 201 && more[1].status === 201 && new Set(staffIds).size === 3, "the same time goes to 3 different technicians");
  check(more[2].status === 409 && more[2].json?.error?.code === "SLOT_TAKEN" && more[2].json.error.alternatives?.length > 0, "then it is full: 409 SLOT_TAKEN with alternatives", oneLine(more[2].json?.display_ar));

  const found = await call("GET", "/v1/bookings?phone=0795550100&status=confirmed", { key });
  check(found.status === 200 && found.json.data.bookings.length === 1, "found by phone", oneLine(found.json?.display_ar));

  check((await call("GET", `/panel/admin/businesses/${businessId}`, { cookie: true })).status === 200, "admin can read the business");
  check((await call("POST", `/panel/admin/businesses/${businessId}/open`, { cookie: true })).status === 200, "admin opens the business calendar");
  const cal = await call("GET", `/panel/app/calendar?from=${slots[0].local_date}&to=${slots[0].local_date}`, { cookie: true });
  check(cal.status === 200 && cal.json.data.bookings.length === 3, "the 3 bookings show in the business calendar");

  const cancelled = await call("POST", `/panel/app/bookings/${id}/cancel`, { cookie: true, body: { reason: "smoke test" } });
  check(cancelled.status === 200 && cancelled.json.data.status === "cancelled", "cancelled from the panel (as the admin)");
  const detail = await call("GET", `/panel/app/bookings/${id}`, { cookie: true });
  check(detail.json?.data?.history?.at(-1)?.by === "admin", "and recorded as made by the admin");
} finally {
  // 4. clean up
  const removed = await call("DELETE", `/panel/admin/businesses/${businessId}`, { cookie: true, body: { confirm_name: name } });
  check(removed.status === 200, "test business deleted again");
  check((await call("GET", "/v1/business", { key })).status === 401, "its key stopped working");
  await call("POST", "/panel/admin/logout", { cookie: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
