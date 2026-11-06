// Local development only: fills a running local server (http://localhost:3000) with a demo business and a few bookings,
// so the panels have something to show. The accounts it creates are throw-away local ones.
//   ADMIN_USER=localadmin ADMIN_PASSWORD=... node web/scripts/dev-seed.mjs
const base = process.env.BASE_URL ?? "http://localhost:3000";
const adminUser = process.env.ADMIN_USER;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminUser || !adminPassword) {
  console.error("Set ADMIN_USER and ADMIN_PASSWORD.");
  process.exit(2);
}
const jar = new Map();
async function call(method, path, { body, key, cookie } = {}) {
  const headers = { ...(body && { "content-type": "application/json" }), ...(key && { authorization: `Bearer ${key}` }) };
  if (cookie) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json?.error ?? json)}`);
  return json;
}

await call("POST", "/panel/admin/login", { body: { username: adminUser, password: adminPassword }, cookie: true });
const created = await call("POST", "/panel/admin/businesses", {
  cookie: true,
  body: { name: "مؤسسة النور", username: "demo", password: "demo-temp-123", goes_to_customer: true, is_test: true, staff_label_ar: "فني", staff_label_en: "Technician" },
});
const key = created.data.api_key;

// log in as the owner and replace the temporary password, like a real owner would
const owner = new Map();
const login = await fetch(base + "/panel/app/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "demo", password: "demo-temp-123" }) });
owner.set("mawid_app", login.headers.getSetCookie()[0].split(";")[0].split("=")[1]);
await fetch(base + "/panel/app/password", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `mawid_app=${owner.get("mawid_app")}` },
  body: JSON.stringify({ current_password: "demo-temp-123", new_password: "demo-pass-123" }),
});

// a few bookings, the way the bot makes them
const customers = [["سامر", "0795550100", "ثلاجة LG — ما بتبرد"], ["ليث", "0791234567", "غسالة — ما بتعصر"], ["سامي", "0771234567", "مكيف — بينقط مي"], ["نور", "0751234567", "فرن غاز — ما بشعل"], ["دانا", "0788888888", "جلاية — صوت عالي"]];
const services = ["ثلاجة", "غسالة", "مكيف", "فرن", "جلاية"];
const times = [["بكرا", "9"], ["بكرا", "11"], ["بكرا", "2 العصر"], ["بعد بكرا", "10"], ["بعد بكرا", "12"]];
for (let i = 0; i < customers.length; i++) {
  const [name, phone, description] = customers[i];
  const check = await call("POST", "/v1/availability/check", { key, body: { service: services[i], zone: "هاشمي شمالي", date: times[i][0], time: times[i][1] } });
  if (!check.data.slot_token) continue;
  await call("POST", "/v1/bookings", { key, body: { slot_token: check.data.slot_token, customer_name: name, customer_phone: phone, description, external_ref: `SR-2026-00001${i}` } });
}
console.log("demo business ready. Owner login:  demo / demo-pass-123   (admin login is the one you passed in)");
