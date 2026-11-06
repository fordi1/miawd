# SPEC — Booking Engine (working name "Mawid / موعد")

Version 0.4 · 2026-11-01 · Status: **approved for build**


v0.4 = like Square / Acuity: availability → create booking. No temporary hold (the bot books only after the customer
confirms — that logic is in the bot). Webhooks reduced to 3 change events. No reminders (the bot sends its own).
Everything not listed here is not built.

---

## 1. What it is

A booking calendar service for any appointment business, controlled by API.

1. **Admin Panel** (platform owner): add / edit / remove businesses. For each business set the name, an initial
   **username + password**, and get its **API key**. See how many businesses and bookings there are, and open any
   business's calendar with full control.
2. **API** (one fixed endpoint for everyone, the key decides the business): free slots, check a time, create,
   reschedule, cancel, look up bookings, and manage staff, hours, days off, services, zones.
   First user: a WhatsApp bot.
3. **Business Panel**: the business logs in with its username + password and manages its own bookings in a calendar.
4. **Docs**: an integration guide for the API (Arabic + English, curl examples, the bot flow).

Out of scope: WhatsApp sending, reminders, payments/money, voice agent.

---

## 2. Architecture

```
 Integrator (e.g. a WhatsApp bot)              Booking Engine server
 ┌──────────────────┐  HTTPS + API key    ┌─────────────────────────────────────┐
 │ his own server   │ ──────────────────▶ │ caddy (HTTPS) ─▶ api (Fastify)      │
 │                  │ ◀────────────────── │   (also sends webhooks, retries)    │
 └──────────────────┘  signed webhooks    │ postgres 17 (+btree_gist)           │
                                          │ web: /admin (Admin) · /app (Business)│
                                          │ backup (daily dump → off-site)      │
                                          └─────────────────────────────────────┘
```

- **Endpoint:** `https://api.<domain>/v1` — the same for every business.
- **API key:** one per business (`bk_…`). Stored hashed, so shown in full **only once** — when the business is created
  or the key is regenerated; afterwards the panel shows `bk_…last4`. "Regenerate" makes a new one, the old one stops.
  The key alone tells the server which business a request is for.
- **Testing:** the admin can mark a business as *test* (e.g. "Demo Repair"). It behaves exactly like a real one, is
  pre-filled with sample data (3 technicians, Amman zones), can be reset, and is excluded from dashboard counts.

---

## 3. Data model (PostgreSQL)

Times stored as UTC `timestamptz`, computed in the business timezone (`Asia/Amman`). Every business table has
`business_id`, and every query is scoped by it.

| Table | Columns |
|---|---|
| `admins` | id, username, password_hash (argon2id) |
| `businesses` | id, name, username (unique), password_hash, must_change_password, api_key_hash, api_key_last4, timezone, goes_to_customer (bool → zones used), staff_label_ar/en ("فني"/"Technician"), settings jsonb (§3.1), webhook_url?, webhook_secret, is_test, active, created_at |
| `staff` | id, business_id, name_ar, name_en, phone?, color, active |
| `staff_services` | staff_id, service_id |
| `staff_zones` | staff_id, zone_id |
| `services` | id, business_id, name_ar, name_en, aliases[], duration_min, active |
| `zones` | id, business_id, name_ar, name_en, aliases[], visit_fee_jod?, active (used only if `goes_to_customer`) |
| `working_hours` | staff_id, weekday 0–6, start_local, end_local (several rows per day allowed) |
| `days_off` | id, business_id, staff_id? (null = whole business, e.g. Eid), during `tstzrange`, reason |
| `bookings` | §3.2 |
| `booking_history` | booking_id, action, by (`api\|business\|admin`), data, at |
| `idempotency_keys` | business_id, key, request_hash, response, created_at (kept 24h) |
| `webhook_deliveries` | id, business_id, event, payload, attempt, status, next_attempt_at, last_error |

### 3.1 Settings per business (defaults)

| Setting | Default |
|---|---|
| slot step | 30 min |
| gap between bookings (travel) | 30 min if `goes_to_customer`, else 0 |
| earliest booking | 2 h from now |
| furthest booking | 14 days ahead |
| changes through the API allowed until | 2 h before the visit (`change_cutoff_min`; the business panel is not limited) |
| default weekly hours | Sat–Thu 09:00–18:00, Fri off |

### 3.2 `bookings`

```
id, business_id, staff_id, service_id, zone_id?,
status          confirmed | completed | cancelled | no_show
starts_at, ends_at,
blocked         tstzrange  -- [starts_at, ends_at + gap)
customer_name, customer_phone (E.164), address?, description?  -- e.g. "ثلاجة LG — ما بتبرد"
external_ref?   -- integrator's id, e.g. SR-2026-000009
visit_fee_jod?, source (api|panel), created_at, updated_at

EXCLUDE USING gist (staff_id WITH =, blocked WITH &&) WHERE (status = 'confirmed')
```
This database rule makes double booking impossible, even when many requests arrive at the same moment.

---

## 4. Booking lifecycle

```
 create ──▶ confirmed ──▶ completed
               │  ╰─ reschedule (stays confirmed, logged in history)
               ├──▶ cancelled
               └──▶ no_show
```

---

## 5. Availability (how free slots are found)

For each active staff member who does the service (and covers the zone, if the business goes to customers):
working hours of that day − days off − existing confirmed bookings (plus the gap) → start times on the 30-min grid
that fit the service duration, not earlier than 2 h from now, not later than 14 days. Merge all staff, one slot per
time (assigned to the staff member with fewer bookings that day), return the earliest options spread over the day.
Each slot has a `slot_token` that is passed back to book it.

Zone and service can be given by id **or by name as the customer wrote it** ("هاشمي شمالي", "ثلاجة"); Arabic is
normalized (hamza forms, ة/ه, ى/ي, tashkeel, all digit forms).

If the chosen time was taken in the meantime, `POST /bookings` returns `SLOT_TAKEN` with the nearest free alternatives.
If the chosen staff member is busy but another eligible one is free at that time, the booking goes to the other one.

---

## 6. API v1

Base `https://api.<domain>/v1` · header `Authorization: Bearer <business API key>` · JSON.
POST requests may send `Idempotency-Key` (a retry with the same key returns the first result, never a second booking).

**Every response** has machine data plus a ready-to-send Jordanian text:

```json
{ "ok": true, "data": { }, "display_ar": "…", "request_id": "req_…" }
{ "ok": false, "error": { "code": "SLOT_TAKEN", "message": "…", "display_ar": "…", "alternatives": [ ] }, "request_id": "req_…" }
```

### 6.1 Booking endpoints

| Method & path | What it does |
|---|---|
| `GET /availability?service=&zone=&date_from=&date_to=&limit=3&booking_id=` | free slots (`booking_id` is for rescheduling: that booking's own time and travel gap count as free) |
| `POST /availability/check` `{service, zone, date, time}` or `{service, zone, start_at}` | "can he come at 5?" → yes + `slot_token`, or no + reason + nearest alternatives (§6.5) |
| `POST /bookings` `{slot_token, customer_name, customer_phone, description?, address?, external_ref?}` | create a confirmed booking (call it only after the customer confirmed) |
| `GET /bookings?phone=&external_ref=&status=&from=&to=&limit=` | find / list bookings, oldest visit first (`from`/`to` are local dates; all statuses unless `status` is given; `limit` default 50, max 100). Cancelled/finished ones are marked in `display_ar` |
| `GET /bookings/{id}` | one booking with history |
| `PATCH /bookings/{id}` | edit customer, description, address, external_ref |
| `POST /bookings/{id}/reschedule` `{slot_token}` | move |
| `POST /bookings/{id}/cancel` `{reason?}` | cancel |
| `POST /bookings/{id}/status` `{status: completed\|no_show}` | mark result |

### 6.2 Business setup endpoints (same things the panel can do)

Everything a business needs can be configured through the API, so a business can be built from nothing. These answers are for
developers: `display_ar` is `null`. Lists return active items only unless `?include_inactive=true`.
**DELETE never erases:** it switches the item off (`active: false`) so past bookings keep their staff member / service / zone;
`PATCH {"active": true}` brings it back. Switching off something that still has a confirmed visit that has not ended
is refused with `409 HAS_UPCOMING_BOOKINGS` (move or cancel those bookings first).

| Method & path | What it does |
|---|---|
| `GET /business` | name, timezone, `goes_to_customer`, staff label, `webhook_url`, `webhook_secret`, and the **effective** settings (defaults filled in) |
| `PATCH /business` `{settings:{…}, webhook_url}` | webhook: see §7.1. Settings: change any of `slot_step_min` (5–120), `gap_min` (0–240), `min_lead_min`, `horizon_days` (1–365), `change_cutoff_min`, `display_digits` (`latin`/`arabic`); unknown keys are refused |
| `GET /staff` · `GET /staff/{id}` | staff with `service_ids`, `zone_ids` and `hours` |
| `POST /staff` | `name_ar` (required), `name_en`, `phone`, `color` (`#RRGGBB`), `service_ids`, `zone_ids`, `hours`. Without `hours` the new staff member gets the default week: Saturday–Thursday 09:00–18:00 |
| `PATCH /staff/{id}` · `DELETE /staff/{id}` | edit (`service_ids` / `zone_ids` replace the whole list) · switch off |
| `PUT /staff/{id}/hours` `{hours:[{weekday,start,end}]}` | replaces the weekly hours. `weekday`: **0 = Sunday … 6 = Saturday**; `start`/`end` `HH:mm`; several intervals per day allowed (split shift), overlapping ones refused; `[]` = never works |
| `GET /days-off?staff_id=&from=&to=` | days off that have not ended yet (from today; `from`/`to` are local dates) |
| `POST /days-off` | either `date_from` + `date_to` (local dates, **inclusive**, whole days) or `start_at` + `end_at` (ISO 8601, part of a day); optional `staff_id` (omit = the whole business) and `reason` |
| `DELETE /days-off/{id}` | removes it (this one really deletes) |
| `GET/POST/PATCH/DELETE /services` (+ `GET /services/{id}`) | `name_ar`, `name_en`, `aliases[]`, `duration_min` (5–720) |
| `GET/POST/PATCH/DELETE /zones` (+ `GET /zones/{id}`) | `name_ar`, `name_en`, `aliases[]`, `visit_fee_jod` (`null` clears). Only for businesses with `goes_to_customer`; others get `422` |

All `POST` setup endpoints accept `Idempotency-Key` (§6.6). Adding days off does not touch bookings that already exist.

### 6.3 Example texts (`display_ar`)

- Slots: "عنا مواعيد فاضية:\n1) بكرا الاثنين الساعة 10 الصبح\n2) بكرا الساعة 1 الظهر\n3) الثلاثاء الساعة 4 العصر\nأي موعد بناسبك؟"
- Not free: "للأسف الساعة 5 المسا مش متاحة 🙏 أقرب مواعيد: اليوم الساعة 3 العصر، أو بكرا الساعة 11 الصبح. شو بناسبك؟"
- Each slot also has `label_ar` ("الاثنين 2 تشرين الثاني، الساعة 10 الصبح") for the bot's own confirmation summary.
- Booked: "تم تثبيت موعدك ✅ الاثنين 2 تشرين الثاني الساعة 10 الصبح. إذا بدك تغيّر أو تلغي احكيلنا هون."

Rules: اليوم/بكرا/بعد بكرا; Levantine month names; الصبح (5–11:59) / الظهر (12–14:59) / العصر (15–16:59) / المسا (from 17:00); ونص/وربع/إلا ربع;
دينار/دينارين/دنانير; Latin digits. Phones accepted as 07…, 962…, +962…, 00962…, any digit form.

### 6.4 Error codes

| Code | HTTP | `display_ar` |
|---|---|---|
| `INVALID_INPUT` | 422 | في معلومة ناقصة أو مش واضحة، ممكن تعيدها؟ |
| `UNAUTHORIZED` | 401 | — (wrong / old key) |
| `NOT_FOUND` | 404 | ما لقيت هالحجز. |
| `ZONE_NOT_FOUND` | 422 | ما لقيت هالمنطقة 🤔 ممكن تكتب اسم الحي؟ |
| `ZONE_NOT_COVERED` | 422 | للأسف ما منغطي هالمنطقة حالياً. |
| `SERVICE_NOT_FOUND` | 422 | — |
| `SLOT_TAKEN` | 409 | للأسف هالموعد انحجز هلأ 😅 هاي أقرب مواعيد فاضية: … |
| `SLOT_TOKEN_EXPIRED` | 422 | خليني أجيبلك المواعيد الفاضية من جديد. |
| `TOO_LATE_TO_CHANGE` | 409 | الموعد قريب كتير وما بنقدر نغيّره هلأ، رح نحوّلك لصاحب المحل. |
| `INVALID_TRANSITION` | 409 | — (e.g. rescheduling a cancelled booking, cancelling a completed one) |
| `INVALID_PHONE` | 422 | الرقم مش واضح، ابعته بالشكل 07XXXXXXXX |
| `IDEMPOTENCY_KEY_REUSED` | 422 | — (same `Idempotency-Key`, different request) |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | — (same key still running; retry in a moment) |
| `RATE_LIMITED` | 429 | — (retry after `Retry-After`) |
| `SERVER_ERROR` | 500 | صار عنا خلل بسيط، جرّب كمان شوي 🙏 |

No free slots is not an error: `slots: []` + "للأسف ما في مواعيد فاضية بهالأيام، بتحب أشوفلك الأسبوع الجاي؟".

### 6.5 `POST /availability/check` — "can he come at 5?"

Body: `service`, `zone` (as in `/availability`), and **either** `start_at` (ISO 8601 with offset, e.g. `2026-11-08T17:00:00+03:00`)
**or** `date` + `time` (both required; no silent default to today).

- `date`: `2026-11-08` (any digit script), `اليوم`, `بكرا`, `بعد بكرا`, `today`, `tomorrow`.
- `time`: `17:00`, `5:30`, `5`, `٥`, `5 المسا`, `ع الخمسة`, `الساعة خمسة ونص`, `5 ونص`, `5 وربع`, `6 إلا ربع`, `5pm`, `1 الظهر`,
  `9 بالليل`. A bare hour 1–7 means afternoon (so `5` = 17:00), 8–11 morning, 12 noon, 13–23 as written.
- Not understood → `422 INVALID_INPUT` with a customer-ready `display_ar` ("ما فهمت الوقت 🤔 …").

Always `200`:

```json
"data": {
  "available": false,
  "reason_code": "FULLY_BOOKED",
  "requested": { "local_date": "2026-11-08", "local_time": "17:00" },
  "slot_token": null, "slot": null,
  "alternatives": [ { "slot_token": "st_…", "start_at": "…", "label_ar": "…" } ]
}
```
When `available: true`: `reason_code: null`, `slot` is the slot object (same shape as in `/availability`), `slot_token` its token (book it
with `POST /bookings`), `alternatives: []`.

`reason_code`: `TOO_SOON`, `BEYOND_HORIZON`, `CLOSURE` (business-wide day off), `DAY_OFF` (no one works that day),
`OUTSIDE_WORKING_HOURS`, `NOT_A_SLOT_TIME` (e.g. 10:10 when slots start every 30 min), `FULLY_BOOKED`.

`alternatives`: up to 3, the same day first (nearest in time), then the following days; searched within 7 days of the
requested date. `display_ar` example: "للأسف بكرا الأحد الساعة 5 المسا مش متاحة 🙏 أقرب مواعيد فاضية: …، أو …. شو بناسبك؟".

### 6.6 Retrying safely — `Idempotency-Key`

Send `Idempotency-Key: <1–255 chars>` on `POST /bookings` (recommended for bots: a timeout then a retry must not fail).
- Same key + same request → the first **successful** result again (same status and body, header `Idempotent-Replayed: true`).
- Same key + different request → `422 IDEMPOTENCY_KEY_REUSED`.
- Same key while the first request is still running → `409 IDEMPOTENCY_IN_PROGRESS` (retry in a moment).
- **Failures are not remembered:** fix the request and send it again with the same key.
- Keys are forgotten after 24 hours; they are per business.
- The key is tied to the exact request (method, path, body): reusing it on another booking is `IDEMPOTENCY_KEY_REUSED`.
- Also accepted (and mostly harmless to repeat anyway) on reschedule, cancel and status.

### 6.7 Changing a booking

- **Reschedule** `POST /bookings/{id}/reschedule {slot_token}`: get the token from `/availability` or `/availability/check`
  **with `booking_id`** (otherwise the booking's own time blocks the neighbouring slots, e.g. "an hour later"). Same slot
  rules as creating: if that staff member just got busy, someone else free at exactly that time is used; otherwise
  `SLOT_TAKEN` + alternatives and the booking stays where it was. A token for another service is refused.
  Moving to the time it already has changes nothing.
- **Cancel** `POST /bookings/{id}/cancel {reason?}`: cancelling an already cancelled booking is a harmless `200`.
- **Status** `POST /bookings/{id}/status {status: completed|no_show}`: only from `confirmed`; repeating the same status is `200`.
- **Edit** `PATCH /bookings/{id}`: any of `customer_name`, `customer_phone`, `description`, `address`, `external_ref`
  (`null` clears description/address/external_ref); unknown fields are refused. Allowed in any status.
- Reschedule and cancel through the API are refused with `TOO_LATE_TO_CHANGE` when the visit starts in less than
  `change_cutoff_min` (default 2 h). Every change is recorded in the booking's `history` (`GET /bookings/{id}`).
- A booking id that belongs to another business is `404 NOT_FOUND`, exactly like one that does not exist.

### 6.8 Rate limit

Each business (= each API key) has its own bucket: **20 requests per second, bursts of up to 40**. Every response carries the
standard headers `RateLimit-Policy: "default";q=20;w=1` and `RateLimit: "default";r=<left>;t=<seconds until the bucket is full>`.
Over the limit: `429 RATE_LIMITED` with `Retry-After: <seconds>`. Requests with a wrong key use nobody's tokens; `/health` is not limited.
(The buckets live in the memory of one server process — fine for one server, to be revisited if the API is ever run on several.)

---

## 7. Webhooks (so the bot knows about changes it did not make)

If a business has a webhook URL, the server POSTs 3 events to it (like Square):
`booking.created`, `booking.updated` (rescheduled, edited, completed, no-show), `booking.cancelled`.
Each carries the booking, who made the change (`api` / `business` / `admin`), a ready `display_ar` for the customer,
and the date/time/area as separate fields for a WhatsApp template.
Signed with HMAC-SHA256 (Standard Webhooks headers) so the receiver can verify it came from us; retried with
increasing delays for up to 24 h if the receiver is down.

### 7.1 Setting it up

`PATCH /business {"webhook_url": "https://…"}` (also in the Admin Panel). `GET /business` shows `webhook_url` and `webhook_secret`
(`whsec_…`, created with the first URL and kept while the URL changes; `{"webhook_url": null}` removes both, so setting a URL
again gives a **new secret** — that is how to rotate it). The URL must be `https://`, without a username/password, and must not
point to localhost or a private network (checked when saved **and** again at every delivery). Redirects are not followed.

### 7.2 What is sent

`POST <url>`, `Content-Type: application/json`, headers exactly as in [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
so its official libraries can verify it:

| Header | Value |
|---|---|
| `webhook-id` | `msg_<uuid>` — the same for every retry of one event: **use it to ignore duplicates** |
| `webhook-timestamp` | unix seconds — refresh on every attempt; reject if it is more than a few minutes off |
| `webhook-signature` | `v1,` + base64 `HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>")`, `key` = base64-decoded part of the secret after `whsec_` |

```json
{
  "id": "evt_<same uuid as msg_>",
  "type": "booking.updated",
  "created_at": "2026-11-02T08:15:00.000Z",
  "actor": "business",
  "data": {
    "booking": { "…the same booking object as the API…" },
    "change": "rescheduled",
    "previous": { "start_at": "2026-11-08T06:00:00.000Z", "staff_id": "…" },
    "display_ar": "تم تغيير موعدك ✅ موعدك الجديد: الأحد 8 تشرين الثاني الساعة 10 الصبح.",
    "template": { "customer_name": "سامر", "date": "الأحد 8 تشرين الثاني", "time": "الساعة 10 الصبح", "zone": "الهاشمي الشمالي" }
  }
}
```

- `actor`: `api` (a call made with the business's own key — the bot can ignore these), `business` (someone in the panel), `admin`.
- `booking.updated` has `change`: `rescheduled` (with `previous`), `edited`, `completed`, `no_show`.
  `booking.cancelled` has `reason`.
- `display_ar` is a ready customer message for `booking.created`, `booking.cancelled` and a reschedule; it is `null` for edits and
  completed / no-show. A cancellation made by the business says "للأسف اضطرينا نلغي موعدك 🙏 إذا بدك نرتبلك موعد ثاني احكيلنا."
- `template` gives the date, time and zone as separate texts for a WhatsApp template (digits follow the business's `display_digits`).
- An event is queued **in the same database transaction as the change** (so no change is lost and no event exists for a change
  that failed); a change that did nothing (cancelling twice, an edit with the same values) sends nothing.

### 7.3 Delivery

A 2xx within 10 s = delivered. Anything else (other status, redirect, timeout, no connection) is retried after
5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h — 10 attempts in about 22 hours — then dropped (`failed`).
The same event is never sent twice at the same moment, even with several server processes.
Events are delivered in the order they were created; a slow receiver delays the ones behind it.

---

## 8. Bot flow

```
problem → brand → area → phone → fee notice
 → GET /availability                 → send display_ar (3 slots)
 → customer picks a number           → that slot_token
   or "ما بيجي ع الخمسة؟"             → POST /availability/check → slot_token or alternatives
 → bot shows its summary + buttons (uses label_ar)
 → "تمام، ثبّت ✅" → POST /bookings (slot_token, external_ref = SR-…)
                      SLOT_TAKEN? → send display_ar with the alternatives
 → webhooks (business moved or cancelled) → bot messages the customer
```

---

## 9. Panels (complete list)

### 9.1 Admin Panel

1. Login (admin username + password).
2. **Dashboard:** number of businesses, bookings this month (confirmed / cancelled / completed), table per business
   with its counts; month selector.
3. **Businesses:** list, add, edit, deactivate, delete. Add/edit = name, username, initial password, goes-to-customer
   yes/no, staff label, test business yes/no.
4. **Business page:** API endpoint + key (shown once on create/regenerate, then last 4), webhook URL, reset
   password, reset test data (test only), **open its calendar** with full control (same screens as the Business Panel).
5. Link to the API docs.

### 9.2 Business Panel

1. Login (username + password from the admin; asked to change the password on first login).
2. **Calendar:** day (column per staff member) / week / month; mobile: day list + month. Filter by staff member and
   status. Today's counts + list.
3. **Booking:** open details; move to another free time or staff member; cancel; mark completed / no-show.
4. **New booking:** service (+ zone) → free times → customer name + phone → save.
5. Search a booking by phone or reference number.
6. **Staff:** add / edit, weekly hours, days off, which services and zones.
7. **Services:** name + duration. **Zones:** name + visit fee (only if goes to customer).
8. **Settings:** booking rules (§3.1), business days off, change password, language AR / EN.

### 9.3 Panel back end (what the two panels call)

Same server, same origin, under `/panel` (no CORS). Answers use the same envelope as the API, with `display_ar: null`;
the panel screens translate by `error.code`.

**Login.** `POST /panel/admin/login` and `POST /panel/app/login` take `{username, password}` and set an `HttpOnly; SameSite=Strict`
cookie (`mawid_admin` / `mawid_app`, 7 days, `Secure` in production). The two cookies are separate: one panel's cookie never works in the other.
A wrong password and an unknown username give the same answer and take the same time. Attempts are limited to 5 per minute per IP
address and 10 per hour per username (`429`). A switched-off business gets `403 ACCOUNT_DISABLED` after a correct password.
Requests that change something and carry an `Origin` of another website are refused (`403 FORBIDDEN`).
The first admin is created with `npm run create-admin -- <username>` on the server (a password is generated and shown once).

**Owner.** `GET /panel/app/me`, `POST /panel/app/password {current_password, new_password}` (8+ characters, different from the
current one; closes the owner's other logins), `POST /panel/app/logout`. With a temporary password every other call is
`403 PASSWORD_CHANGE_REQUIRED` until it is replaced.

**Admin Panel** (`/panel/admin/…`, needs the admin cookie):

| Call | What it does |
|---|---|
| `GET /dashboard?month=yyyy-MM` | number of businesses (test ones excluded), and bookings **made** in that Amman calendar month, by their status now: total / confirmed / cancelled / completed / no_show — overall and per business |
| `GET /businesses?month=` · `GET /businesses/{id}` | every business (test ones marked) with the same counts, `api_key_last4`, webhook URL and secret — never the full key or a password hash |
| `POST /businesses` | `name`, `username` (3–50: a-z 0-9 . _ -), `password` (temporary, 8+), `goes_to_customer`, `staff_label_ar/en`, `is_test`. Answers with the business **and its API key, shown this once**. A test business is filled with sample data (5 services, 8 Amman zones, 3 technicians) |
| `PATCH /businesses/{id}` | name, username, `goes_to_customer`, staff labels, `active`, `webhook_url` (same rules as §7.1). Switching off closes the owner's logins |
| `POST /businesses/{id}/api-key` | a new key (shown once); the old one stops at once |
| `POST /businesses/{id}/password {password}` | a new temporary password; the owner must change it and all their logins are closed |
| `POST /businesses/{id}/reset-test-data` | test businesses only (`403` otherwise): wipes bookings and setup and loads the sample data again |
| `DELETE /businesses/{id} {confirm_name}` | deletes the business and everything of it, only if its name is typed exactly |
| `POST /businesses/{id}/open` | gives the admin a Business Panel session for it: full control, no password change needed, works even if the business is switched off, and every change is recorded as made by `admin` |

**Business Panel** (`/panel/app/…`, needs the owner cookie). The setup calls of §6.2 (`/staff`, `/services`, `/zones`, `/days-off`,
`/business`) exist here too, identical, except that the webhook is neither shown nor editable. Besides:

| Call | What it does |
|---|---|
| `GET /calendar?from=&to=` | everything one screen needs for up to 62 days: bookings (with service / zone / staff names), active staff, services, zones, days off |
| `GET /slots?service_id=&zone_id=&date_from=&date_to=&booking_id=` | every free time (one per start time, with its staff member) for a manual booking or a move |
| `POST /bookings` | `service_id`, `staff_id`, `start_at`, `customer_name`, `customer_phone`, optional `zone_id`, `description`, `address`, `external_ref`. The owner may book any time; only a clash with another booking is refused (`SLOT_TAKEN`) |
| `GET /bookings?phone=&external_ref=&status=&from=&to=` · `GET /bookings/{id}` | find / one booking with its history |
| `PATCH /bookings/{id}` · `POST …/reschedule {staff_id, start_at}` · `POST …/cancel {reason?}` · `POST …/status {status}` | change a booking. **Not limited by the 2-hour rule**; recorded as made by `business` (or `admin`) |

### 9.4 Docs (public at `/docs`)

Integration guide AR + EN: getting the key, authentication, every endpoint with curl examples, error codes, webhooks
and signature check, the full bot flow (§8), test business. Plus the OpenAPI file and a Postman collection.

---

## 10. Design

References: the booking dashboard mock + the soft calendar app. Font **Vazirmatn** (used by OpenSooq; readable at small
sizes). Colors: background `#EEF2F7`, cards white, primary `#4466F2`, confirmed green `#22C77A`, completed violet
`#8B6CF6`, cancelled red `#EF4444`. Rounded cards (16px), soft shadows, floating "+" button. RTL Arabic (Jordanian
wording) and English. Responsive: desktop sidebar + calendar; mobile 375px day list + bottom bar. Numbers
proportional, buttons never wrap, controls ≥ 44px.

---

## 11. Quality targets

- Free slots answered in < 300 ms.
- Zero double bookings when 50 requests try the same slot at once (tested).
- HTTPS only; API keys stored as keyed hashes (HMAC-SHA256 with a server-side pepper); passwords stored with **scrypt** (salted, 32 MiB per hash; chosen over argon2id because it ships inside Node with no native build); each business sees only its own data.
- Daily database backup kept 14 days, copied off the server.
- `/health` endpoint; logs kept 14 days.

---

## 12. Tech

TypeScript · Fastify · PostgreSQL 17 · React + Vite + Tailwind · Docker Compose + Caddy on one server.
Tests: Vitest on a real Postgres, plus a scripted Jordanian bot conversation and a load test.

---

## 13. Build order

| Days | Deliverable |
|---|---|
| 1–2 | Database, availability, create booking, double-booking test |
| 3–4 | Full API + Arabic texts + webhooks + test business |
| 5 | Docs + Postman → **send the integrator the docs and a test key** |
| 6–7 | Business Panel |
| 8 | Admin Panel |
| 9–10 | Tests, deploy, handover |
