# Mawid Booking API — integration guide

A calendar your bot can talk to. It knows every technician's real working hours and zones, offers free times, books them, moves them and cancels them — and tells you when the business changes something by hand. **Everything it says to the customer comes back as ready-to-send Jordanian Arabic** (`display_ar`), so your bot does not have to phrase dates and times.

[API reference (every endpoint, try it)](/docs) · [OpenAPI file](/docs/openapi.json) · [Postman collection](/docs/postman.json) · [الدليل بالعربي](/docs/guide/ar)

## 1. What you get

| | |
|---|---|
| **Base URL** | `https://YOUR-HOST/v1` — the same for every business |
| **API key** | one per business, e.g. `bk_live_…` (`bk_test_…` for a test business). It goes in every request: `Authorization: Bearer <key>`. The key alone tells us *which business* the call is for, so you never send a business id — switching business means switching key |
| **Where the key comes from** | the platform admin creates the business and gives you the key **once** (it cannot be shown again; ask for a new one if it is lost — the old one then stops working) |
| **A business to test with** | a *test business* ("Demo Repair") comes with 3 technicians, 5 services and 8 Amman zones, so you can integrate before touching a real client |

Every answer has the same shape:

```json
{ "ok": true,  "data": { "…": "for your code" }, "display_ar": "نص جاهز للإرسال", "request_id": "req_0f27…" }
{ "ok": false, "error": { "code": "SLOT_TAKEN", "message": "…", "display_ar": "…", "alternatives": [ ] }, "request_id": "req_0f27…" }
```

Send `display_ar` to the customer as it is. Use `data` and `error.code` for your logic. Quote `request_id` if you ask us for help.

## 2. Five minutes with curl

```bash
export BASE=https://YOUR-HOST/v1
export KEY=bk_test_PASTE_YOUR_KEY
```

**Which times are free?** Send the service and the area *the way the customer wrote them*:

```bash
curl -sG "$BASE/availability" -H "Authorization: Bearer $KEY" \
  --data-urlencode "service=ثلاجة" --data-urlencode "zone=هاشمي شمالي"
```

```json
{
  "ok": true,
  "data": {
    "service": { "id": "…", "name_ar": "صيانة ثلاجة", "duration_min": 60 },
    "zone": { "id": "…", "name_ar": "الهاشمي الشمالي", "visit_fee_jod": "10.000" },
    "slots": [
      { "slot_token": "st_eyJ…", "start_at": "2026-11-02T07:00:00.000Z", "local_date": "2026-11-02", "local_time": "10:00",
        "part_of_day": "morning", "label_ar": "الاثنين 2 تشرين الثاني، الساعة 10 الصبح" }
    ]
  },
  "display_ar": "عنا مواعيد فاضية:\n1) بكرا الاثنين الساعة 10 الصبح\n2) بكرا الاثنين الساعة 1 الظهر\n3) بكرا الاثنين الساعة 4 العصر\nأي موعد بناسبك؟"
}
```

The customer picks "2" → you keep `slots[1].slot_token`. (A token is valid for 15 minutes.)

**The customer says "ما بيجي ع الخمسة؟" ("can he come at 5?")**

```bash
curl -s "$BASE/availability/check" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"service":"ثلاجة","zone":"هاشمي شمالي","date":"بكرا","time":"ع الخمسة"}'
```

If 5 pm is free you get `available: true` and a `slot_token` ready to book. If not: `available: false`, a `reason_code`, up to 3 nearby `alternatives` (each with its own `slot_token`), and a message like *"للأسف بكرا الاثنين الساعة 5 المسا مش متاحة 🙏 أقرب مواعيد فاضية: …. شو بناسبك؟"*.

`date` understands `بكرا`, `اليوم`, `بعد بكرا`, `2026-11-08` (any digit script). `time` understands `17:00`, `5`, `٥`, `5 المسا`, `ع الخمسة`, `الساعة خمسة ونص`, `5 ونص`, `6 إلا ربع`, `5pm`, `1 الظهر`, `9 بالليل` — a bare hour from 1 to 7 means afternoon. You can also send an exact `start_at` (ISO 8601) instead of `date` + `time`.

**The customer confirmed → book it.**

```bash
curl -s "$BASE/bookings" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: ticket-SR-2026-000009" \
  -d '{"slot_token":"st_eyJ…","customer_name":"سامر","customer_phone":"0795550100",
       "description":"ثلاجة LG — ما بتبرد","address":"عمان - الهاشمي الشمالي","external_ref":"SR-2026-000009"}'
```

```json
{ "ok": true, "data": { "id": "…", "status": "confirmed", "start_at": "2026-11-02T07:00:00.000Z", "customer_phone": "+962795550100",
    "external_ref": "SR-2026-000009", "visit_fee_jod": "10.000", "label_ar": "الاثنين 2 تشرين الثاني، الساعة 10 الصبح" },
  "display_ar": "تم تثبيت موعدك ✅ الاثنين 2 تشرين الثاني الساعة 10 الصبح. إذا بدك تغيّر أو تلغي احكيلنا هون." }
```

Phone numbers are accepted in any Jordanian way of writing (`0795550100`, `962795550100`, `+962 79 555 0100`, `٠٧٩٥٥٥٠١٠٠`) and returned as `+962…`.

## 3. Where it fits in your conversation

Your flow today: *problem → brand → area → phone → visit-fee notice → "تمام، ثبّت ✅" → ticket SR-…*. With the calendar:

| Step | You do | Call |
|---|---|---|
| problem, brand, area, phone, fee notice | as today | — |
| offer times | send `display_ar` | `GET /availability` |
| customer picks a number | keep that slot's `slot_token` | — |
| customer asks for another time ("ما بيجي ع الخمسة") | send `display_ar`, keep the new token | `POST /availability/check` |
| summary + your confirm buttons | build it from `label_ar`, `visit_fee_jod`… | — |
| customer taps **"تمام، ثبّت ✅"** | create the booking, then your ticket (keep `data.id` in it) | `POST /bookings` with `external_ref` = your ticket number |
| customer taps "لأ، شكراً" | nothing to cancel — **there is no hold** | — |

**There is no "hold" step on purpose:** you book only after the customer confirmed, and if somebody took that time meanwhile you get `409 SLOT_TAKEN` with ready alternatives (send its `display_ar`, the customer picks again, you retry). If the chosen technician just got busy but another one is free at the same time, the booking silently goes to the other one.

## 4. Changing and cancelling

1. Find the booking: `GET /bookings?phone=0795550100&status=confirmed` (or `?external_ref=SR-2026-000009`). `display_ar` lists them ("عندك حجز واحد: 1) بكرا الاثنين الساعة 10 الصبح").
2. **Move:** ask for times *with the booking's id* — `GET /availability?...&booking_id=<id>` or `POST /availability/check` with `"booking_id"` — otherwise the booking's own time blocks the neighbouring slots and "an hour later" would look taken. Then `POST /bookings/{id}/reschedule {"slot_token": …}`.
3. **Cancel:** `POST /bookings/{id}/cancel {"reason": "…"}` — repeating it is harmless.
4. **Too close to the visit?** Through the API a booking can be moved or cancelled until **2 hours before** it starts (setting `change_cutoff_min`). After that you get `409 TOO_LATE_TO_CHANGE` with a ready message that hands the customer to the shop owner.
5. After the visit you may mark it: `POST /bookings/{id}/status {"status":"completed"}` or `"no_show"`.
6. Fix customer data: `PATCH /bookings/{id}`.

## 5. Webhooks — changes you did not make

The owner can move or cancel a booking in the panel. Your bot must tell the customer. Give us a URL:

```bash
curl -s -X PATCH "$BASE/business" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"webhook_url":"https://bot.example.com/hooks/booking"}'
# → data.webhook_secret = "whsec_…"   (also shown by GET /business)
```

The URL must be `https://`, public (no localhost or private networks), without a username/password. We `POST` JSON with three events: `booking.created`, `booking.updated` (`data.change` = `rescheduled` / `edited` / `completed` / `no_show`) and `booking.cancelled`:

```json
{
  "id": "evt_…", "type": "booking.updated", "created_at": "2026-11-02T08:15:00.000Z",
  "actor": "business",
  "data": {
    "booking": { "id": "…", "status": "confirmed", "start_at": "2026-11-08T07:00:00.000Z", "customer_phone": "+962795550100", "external_ref": "SR-2026-000009" },
    "change": "rescheduled",
    "previous": { "start_at": "2026-11-08T06:00:00.000Z", "staff_id": "…" },
    "display_ar": "تم تغيير موعدك ✅ موعدك الجديد: الأحد 8 تشرين الثاني الساعة 10 الصبح.",
    "template": { "customer_name": "سامر", "date": "الأحد 8 تشرين الثاني", "time": "الساعة 10 الصبح", "zone": "الهاشمي الشمالي" }
  }
}
```

- **`actor`**: `api` = something *your own key* did (you can ignore it), `business` = the owner in the panel, `admin` = our admin. When the business cancels, `display_ar` apologises: *"للأسف اضطرينا نلغي موعدك 🙏 إذا بدك نرتبلك موعد ثاني احكيلنا."*
- **`display_ar`** is `null` for edits, completed and no-show (nothing to tell the customer).
- **WhatsApp's 24-hour window is yours to handle.** Inside it, send `display_ar`. Outside it, fill your approved template from `data.template` (`customer_name`, `date`, `time`, `zone`) — the strings are already in Jordanian Arabic.
- Find the customer by `data.booking.customer_phone` and your ticket by `data.booking.external_ref`.

**Verify every call** (it is a standard [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) signature, so its official libraries work as they are). Headers: `webhook-id` (`msg_…`, **the same on every retry — use it to ignore duplicates**), `webhook-timestamp` (unix seconds), `webhook-signature` (`v1,<base64>`). The signature is `HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>")`, base64, where `key` is the base64-decoded part of the secret after `whsec_`. Use the **raw** body, not re-serialised JSON.

```js
// Node.js
import crypto from "node:crypto";
export function verify(rawBody, headers, secret) {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"];
  if (!id || !ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay protection
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = "v1," + crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  return sig.split(" ").some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
```

```python
# Python
import base64, hashlib, hmac, time

def verify(raw_body: bytes, headers: dict, secret: str) -> bool:
    msg_id, ts, sig = headers.get("webhook-id"), headers.get("webhook-timestamp"), headers.get("webhook-signature")
    if not (msg_id and ts and sig) or abs(time.time() - int(ts)) > 300:
        return False
    key = base64.b64decode(secret.removeprefix("whsec_"))
    expected = "v1," + base64.b64encode(hmac.new(key, f"{msg_id}.{ts}.".encode() + raw_body, hashlib.sha256).digest()).decode()
    return any(hmac.compare_digest(s, expected) for s in sig.split(" "))
```

**Delivery:** answer with any `2xx` within 10 seconds. Anything else (other status, redirect, timeout) is retried after 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h and 12 h — ten attempts in about 22 hours — then dropped. Events arrive in the order they happened. To **rotate the secret**, set `webhook_url` to `null` and then set it again.

## 6. When something goes wrong

Every error has a stable `error.code`. `display_ar` is already worded for the customer (it is `null` for errors that are yours to fix).

| `error.code` | HTTP | What it means → what the bot does |
|---|---|---|
| `SLOT_TAKEN` | 409 | Someone took that time. `error.alternatives` has fresh options → send `display_ar`, let the customer choose |
| `SLOT_TOKEN_EXPIRED` | 422 | The token is older than 15 minutes → ask `/availability` again |
| `ZONE_NOT_FOUND` / `ZONE_NOT_COVERED` | 422 | Area not recognised / nobody covers it → send `display_ar` |
| `SERVICE_NOT_FOUND` | 422 | Unknown service → your mapping is wrong |
| `INVALID_PHONE` | 422 | Not a Jordanian mobile → send `display_ar` and ask again |
| `TOO_LATE_TO_CHANGE` | 409 | Visit starts in under 2 hours → send `display_ar`, hand over to the owner |
| `INVALID_TRANSITION` | 409 | e.g. moving a cancelled booking |
| `HAS_UPCOMING_BOOKINGS` | 409 | (setup) you switched off something that still has visits |
| `INVALID_INPUT` | 422 | A field is missing or wrong → `error.fields[]` says which |
| `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_IN_PROGRESS` | 422 / 409 | See below |
| `UNAUTHORIZED` | 401 | Missing, wrong or replaced key |
| `RATE_LIMITED` | 429 | Slow down: wait `Retry-After` seconds |
| `SERVER_ERROR` | 500 | Our fault; retry once |
| `NOT_FOUND` | 404 | The booking does not exist (or belongs to another business) |

## 7. Retrying safely, and limits

- **Idempotency.** Send `Idempotency-Key: <anything unique, up to 255 chars>` on `POST`s (use your ticket number). The same key with the same request returns the *first successful result again* (header `Idempotent-Replayed: true`) and never books twice; the same key with a *different* request is `422 IDEMPOTENCY_KEY_REUSED`; while the first call is still running you get `409 IDEMPOTENCY_IN_PROGRESS`. Failures are not remembered — fix the request and send it again. Keys are forgotten after 24 hours.
- **Rate limit.** 20 requests per second per business, bursts of up to 40. Every answer has `RateLimit-Policy` and `RateLimit` headers; over the limit you get `429` with `Retry-After`.
- **Time.** Times you read are UTC (`start_at`); `local_date` / `local_time` / `label_ar` are in the business's time zone (`Asia/Amman`, UTC+3 all year).

## 8. Setting a business up through the API

You can do everything the panel does (the owner can also do it in the panel). Weekdays are numbered **0 = Sunday … 6 = Saturday**. `DELETE` never erases: it switches the item off (`active: false`) and `PATCH {"active": true}` brings it back; it is refused (`409 HAS_UPCOMING_BOOKINGS`) while a confirmed visit that has not ended still depends on it.

```bash
# a service (aliases = other ways customers say it)
curl -s "$BASE/services" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name_ar":"صيانة ثلاجة","aliases":["ثلاجة","براد"],"duration_min":60}'
# a zone with its visit fee (only for businesses that go to the customer)
curl -s "$BASE/zones" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name_ar":"الهاشمي الشمالي","aliases":["هاشمي"],"visit_fee_jod":10}'
# a technician who does that service in that zone; no "hours" = Saturday–Thursday 09:00–18:00
curl -s "$BASE/staff" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name_ar":"محمود العلي","service_ids":["<service id>"],"zone_ids":["<zone id>"]}'
# his hours: Sundays split shift, Friday off
curl -s -X PUT "$BASE/staff/<staff id>/hours" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"hours":[{"weekday":0,"start":"09:00","end":"13:00"},{"weekday":0,"start":"16:00","end":"20:00"},{"weekday":6,"start":"09:00","end":"18:00"}]}'
# a holiday for the whole business (dates are inclusive), or one technician with "staff_id"
curl -s "$BASE/days-off" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"date_from":"2026-11-05","date_to":"2026-11-06","reason":"إجازة"}'
# rules: slot_step_min, gap_min (travel gap), min_lead_min, horizon_days, change_cutoff_min, display_digits
curl -s -X PATCH "$BASE/business" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"settings":{"gap_min":30,"display_digits":"latin"}}'
```

## 9. Tools for your LLM

If an LLM drives your bot, these definitions map one-to-one onto the calls above (JSON Schema, usable as OpenAI-style `parameters` or Anthropic-style `input_schema`). Keep `display_ar` in the tool result so the model can quote it.

```json
[
  { "name": "find_slots", "description": "List free appointment times (GET /availability). Use the customer's own words for service and zone.",
    "parameters": { "type": "object", "required": ["service"], "properties": {
      "service": { "type": "string", "description": "e.g. ثلاجة" }, "zone": { "type": "string", "description": "e.g. هاشمي شمالي" },
      "date_from": { "type": "string", "description": "yyyy-MM-dd" }, "booking_id": { "type": "string", "description": "only when rescheduling" } } } },
  { "name": "check_time", "description": "Is this exact time free? (POST /availability/check). Returns alternatives when it is not.",
    "parameters": { "type": "object", "required": ["service", "date", "time"], "properties": {
      "service": { "type": "string" }, "zone": { "type": "string" }, "date": { "type": "string", "description": "بكرا, اليوم or yyyy-MM-dd" },
      "time": { "type": "string", "description": "as the customer said it: ع الخمسة, 5 المسا, 17:00" }, "booking_id": { "type": "string" } } } },
  { "name": "book_slot", "description": "Create the booking — ONLY after the customer confirmed the summary (POST /bookings).",
    "parameters": { "type": "object", "required": ["slot_token", "customer_name", "customer_phone"], "properties": {
      "slot_token": { "type": "string" }, "customer_name": { "type": "string" }, "customer_phone": { "type": "string" },
      "description": { "type": "string" }, "address": { "type": "string" }, "external_ref": { "type": "string", "description": "your ticket number" } } } },
  { "name": "find_booking", "description": "Find a customer's bookings (GET /bookings).",
    "parameters": { "type": "object", "properties": { "phone": { "type": "string" }, "external_ref": { "type": "string" }, "status": { "type": "string", "enum": ["confirmed", "completed", "cancelled", "no_show"] } } } },
  { "name": "reschedule_booking", "description": "Move a booking to a slot_token obtained with its booking_id (POST /bookings/{id}/reschedule).",
    "parameters": { "type": "object", "required": ["booking_id", "slot_token"], "properties": { "booking_id": { "type": "string" }, "slot_token": { "type": "string" } } } },
  { "name": "cancel_booking", "description": "Cancel a booking (POST /bookings/{id}/cancel).",
    "parameters": { "type": "object", "required": ["booking_id"], "properties": { "booking_id": { "type": "string" }, "reason": { "type": "string" } } } }
]
```

## 10. Good to know

- A `slot_token` is signed, tied to your business and valid for **15 minutes**. Tokens are cheap: ask again rather than keeping old ones.
- `external_ref` (your ticket number) is **unique per business**; booking or editing with one that is already used gives `422 INVALID_INPUT`.
- Times are offered on a 30-minute grid by default and never earlier than 2 hours from now or later than 14 days ahead (all configurable per business).
- The list endpoints return the first 100 results.
- Bookings made by the owner in the panel look the same as yours (`source: "panel"`) and also trigger `booking.created`.
