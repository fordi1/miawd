# دليل الربط مع واجهة «موعد» (Mawid API)

تقويم بيحكي معه البوت تبعك. بيعرف ساعات دوام كل فني ومناطقه الحقيقية، بيعرض الأوقات الفاضية، بيحجز، بيغيّر، بيلغي، وبيبلّغك إذا صاحب المحل غيّر اشي بإيده. **كل جملة بدك تبعتها للزبون بترجع جاهزة بلهجة أردنية** (`display_ar`)، فالبوت ما بحتاج يصيغ التواريخ والأوقات.

[مرجع الـ API (كل الـ endpoints مع تجربة)](/docs) · [ملف OpenAPI](/docs/openapi.json) · [مجموعة Postman](/docs/postman.json) · [English guide](/docs/guide/en)

## 1. شو بتاخد

| | |
|---|---|
| **الرابط الأساسي (Base URL)** | `https://YOUR-HOST/v1` — نفسه لكل الكسب‌وكارات (الأعمال) |
| **مفتاح الـ API** | مفتاح لكل محل، شكله `bk_live_…` (و`bk_test_…` للمحل التجريبي). بينحط بكل طلب: `Authorization: Bearer <المفتاح>`. المفتاح لحاله بيحدد أي محل المقصود، فما بتبعت رقم المحل أبداً — لتغيّر المحل غيّر المفتاح |
| **من وين بيجي المفتاح** | مدير المنصة بيعمل المحل وبيعطيك المفتاح **مرة وحدة** (ما بينعرض مرة ثانية؛ إذا ضاع اطلب مفتاح جديد والقديم بيوقف فوراً) |
| **محل للتجربة** | *محل تجريبي* («Demo Repair») فيه 3 فنيين و5 خدمات و8 مناطق من عمان، عشان تجرّب قبل ما تلمس زبون حقيقي |

كل جواب بنفس الشكل:

```json
{ "ok": true,  "data": { "…": "للكود تبعك" }, "display_ar": "نص جاهز للإرسال", "request_id": "req_0f27…" }
{ "ok": false, "error": { "code": "SLOT_TAKEN", "message": "…", "display_ar": "…", "alternatives": [ ] }, "request_id": "req_0f27…" }
```

ابعت `display_ar` للزبون زي ما هو. استعمل `data` و`error.code` للمنطق. وإذا بدك مساعدة منا ابعتلنا `request_id`.

## 2. خمس دقايق مع curl

```bash
export BASE=https://YOUR-HOST/v1
export KEY=bk_test_PASTE_YOUR_KEY
```

**أي الأوقات فاضية؟** ابعت الخدمة والمنطقة **زي ما كتبها الزبون**:

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

الزبون اختار «2» ← احتفظ بـ `slots[1].slot_token` (التوكن صالح 15 دقيقة).

**الزبون قال «ما بيجي ع الخمسة؟»**

```bash
curl -s "$BASE/availability/check" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"service":"ثلاجة","zone":"هاشمي شمالي","date":"بكرا","time":"ع الخمسة"}'
```

إذا الخمسة فاضية بيرجع `available: true` مع `slot_token` جاهز للحجز. وإذا لأ: `available: false` مع `reason_code` وحتى 3 بدائل قريبة (لكل واحد `slot_token`) ورسالة مثل: *«للأسف بكرا الاثنين الساعة 5 المسا مش متاحة 🙏 أقرب مواعيد فاضية: …. شو بناسبك؟»*

`date` بيفهم: `بكرا`، `اليوم`، `بعد بكرا`، `2026-11-08` (بأي أرقام). `time` بيفهم: `17:00`، `5`، `٥`، `5 المسا`، `ع الخمسة`، `الساعة خمسة ونص`، `5 ونص`، `6 إلا ربع`، `5pm`، `1 الظهر`، `9 بالليل` — والساعة من 1 لـ 7 بدون توضيح يعني بعد الظهر. وممكن بدل `date` و`time` تبعت `start_at` (ISO 8601).

**الزبون أكّد ← احجز.**

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

أرقام الهاتف بتنقبل بأي كتابة أردنية (`0795550100`، `962795550100`، `+962 79 555 0100`، `٠٧٩٥٥٥٠١٠٠`) وبترجع بصيغة `+962…`.

## 3. وين بيدخل بمحادثتك

مسارك الحالي: *المشكلة ← الماركة ← المنطقة ← الرقم ← إشعار رسوم الزيارة ← «تمام، ثبّت ✅» ← تذكرة SR-…*. مع التقويم:

| الخطوة | شو بتعمل | الـ API |
|---|---|---|
| المشكلة، الماركة، المنطقة، الرقم، رسوم الزيارة | متل ما هو | — |
| عرض الأوقات | ابعت `display_ar` | `GET /availability` |
| الزبون اختار رقم | احتفظ بـ `slot_token` تبعه | — |
| الزبون بدو وقت ثاني («ما بيجي ع الخمسة») | ابعت `display_ar` واحتفظ بالتوكن الجديد | `POST /availability/check` |
| الملخص وأزرارك | ابنيه من `label_ar` و`visit_fee_jod`… | — |
| الزبون ضغط **«تمام، ثبّت ✅»** | اعمل الحجز ثم تذكرتك (واحتفظ بـ `data.id`) | `POST /bookings` مع `external_ref` = رقم تذكرتك |
| الزبون ضغط «لأ، شكراً» | ما في شي تلغيه — **ما في «حجز مؤقت»** | — |

**ما في خطوة «حجز مؤقت» بقصد:** بتحجز بعد ما الزبون يأكّد، وإذا حدا أخد هالوقت بالفاصل بيجيك `409 SLOT_TAKEN` مع بدائل جاهزة (ابعت `display_ar` تبعه والزبون بيختار من جديد). وإذا الفني المختار صار مشغول وفي فني ثاني فاضي بنفس الوقت، الحجز بيروح للثاني بصمت.

## 4. التغيير والإلغاء

1. دوّر على الحجز: `GET /bookings?phone=0795550100&status=confirmed` (أو `?external_ref=SR-2026-000009`). و`display_ar` بيعدّدها («عندك حجز واحد: 1) بكرا الاثنين الساعة 10 الصبح»).
2. **التأجيل/التقديم:** اطلب الأوقات **مع رقم الحجز** — `GET /availability?...&booking_id=<id>` أو `POST /availability/check` مع `"booking_id"` — وإلا وقت الحجز نفسه بيسدّ الأوقات اللي حواليه و«ساعة بعد» بتبين محجوزة. بعدها `POST /bookings/{id}/reschedule {"slot_token": …}`.
3. **الإلغاء:** `POST /bookings/{id}/cancel {"reason": "…"}` — وتكراره ما بسبب مشكلة.
4. **الزيارة قريبة؟** عن طريق الـ API ممكن تغيّر أو تلغي لحد **ساعتين قبل** الموعد (الإعداد `change_cutoff_min`). بعدها بيجيك `409 TOO_LATE_TO_CHANGE` مع رسالة جاهزة بتحوّل الزبون لصاحب المحل.
5. بعد الزيارة ممكن تعلّمها: `POST /bookings/{id}/status {"status":"completed"}` أو `"no_show"`.
6. تصحيح بيانات الزبون: `PATCH /bookings/{id}`.

## 5. الـ Webhooks — تغييرات ما عملتها إنت

صاحب المحل ممكن يأجّل أو يلغي حجز من لوحته، والبوت لازم يبلّغ الزبون. أعطينا رابط:

```bash
curl -s -X PATCH "$BASE/business" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"webhook_url":"https://bot.example.com/hooks/booking"}'
# ← data.webhook_secret = "whsec_…"   (وبينعرض كمان بـ GET /business)
```

الرابط لازم يكون `https://` وعام (مش localhost ولا شبكة داخلية) وبدون اسم مستخدم/كلمة سر. بنبعتلك JSON بثلاث أحداث: `booking.created`، `booking.updated` (`data.change` = `rescheduled` / `edited` / `completed` / `no_show`) و`booking.cancelled`:

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

- **`actor`**: `api` = اشي عمله مفتاحك إنت (تجاهله)، `business` = صاحب المحل من اللوحة، `admin` = إدارة المنصة. وإذا المحل هو اللي لغى، `display_ar` بيعتذر: *«للأسف اضطرينا نلغي موعدك 🙏 إذا بدك نرتبلك موعد ثاني احكيلنا.»*
- **`display_ar`** بتكون `null` لتعديل البيانات ولـ completed و no_show (ما في شي تقوله للزبون).
- **نافذة الـ 24 ساعة بتاعة واتساب عليك إنت.** جوّاها ابعت `display_ar`. وبرّاها عبّي القالب المعتمد من `data.template` (`customer_name`، `date`، `time`، `zone`) — النصوص جاهزة بلهجة أردنية.
- لاقي الزبون من `data.booking.customer_phone` وتذكرتك من `data.booking.external_ref`.

**تحقق من كل طلب** (التوقيع حسب معيار [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)، فمكتباته الرسمية بتشتغل مباشرة). الهيدرات: `webhook-id` (`msg_…` — **نفسه بكل إعادة إرسال، استعمله لتتجاهل المكرر**)، `webhook-timestamp` (ثواني يونكس)، `webhook-signature` (`v1,<base64>`). التوقيع هو `HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<الجسم الخام>")` بصيغة base64، و`key` هو الجزء بعد `whsec_` بعد فك base64. استعمل الجسم **الخام** مش JSON معاد تركيبه.

```js
// Node.js
import crypto from "node:crypto";
export function verify(rawBody, headers, secret) {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"];
  if (!id || !ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // حماية من إعادة الإرسال
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

**التسليم:** رد بأي `2xx` خلال 10 ثواني. غير هيك (رمز ثاني، تحويل، انتهاء مهلة) بنعيد بعد 5 ث، 30 ث، دقيقتين، 10 دقايق، 30 دقيقة، ساعة، 3 ساعات، 6 ساعات، 12 ساعة — عشر محاولات بحوالي 22 ساعة — وبعدها بنتركه. الأحداث بتوصل بترتيب حدوثها. لتغيير الـ secret خلّي `webhook_url` بـ `null` وبعدين حطّه من جديد.

## 6. لما يصير خطأ

كل خطأ إله `error.code` ثابت. و`display_ar` جاهز للزبون (بيكون `null` للأخطاء اللي عليك تصلحها).

| `error.code` | HTTP | معناه ← شو يعمل البوت |
|---|---|---|
| `SLOT_TAKEN` | 409 | حدا أخد الوقت. في `error.alternatives` بدائل جديدة ← ابعت `display_ar` ودع الزبون يختار |
| `SLOT_TOKEN_EXPIRED` | 422 | التوكن أقدم من 15 دقيقة ← اسأل `/availability` من جديد |
| `ZONE_NOT_FOUND` / `ZONE_NOT_COVERED` | 422 | المنطقة مش مفهومة / ما حدا بغطيها ← ابعت `display_ar` |
| `SERVICE_NOT_FOUND` | 422 | خدمة مش معروفة ← الربط عندك غلط |
| `INVALID_PHONE` | 422 | مش رقم موبايل أردني ← ابعت `display_ar` واسأل من جديد |
| `TOO_LATE_TO_CHANGE` | 409 | الزيارة بعد أقل من ساعتين ← ابعت `display_ar` وحوّل لصاحب المحل |
| `INVALID_TRANSITION` | 409 | مثلاً تأجيل حجز ملغي |
| `HAS_UPCOMING_BOOKINGS` | 409 | (إعدادات) طفيت اشي لساته إله زيارات |
| `INVALID_INPUT` | 422 | حقل ناقص أو غلط ← `error.fields[]` بيحدد أي واحد |
| `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_IN_PROGRESS` | 422 / 409 | شوف تحت |
| `UNAUTHORIZED` | 401 | مفتاح ناقص أو غلط أو مستبدل |
| `RATE_LIMITED` | 429 | خفف: استنى `Retry-After` ثواني |
| `SERVER_ERROR` | 500 | غلطتنا؛ جرّب مرة ثانية |
| `NOT_FOUND` | 404 | الحجز مش موجود (أو لمحل ثاني) |

## 7. إعادة المحاولة بأمان، والحدود

- **Idempotency.** ابعت `Idempotency-Key: <أي نص فريد لحد 255 حرف>` مع الـ `POST` (استعمل رقم تذكرتك). نفس المفتاح مع نفس الطلب بيرجّع *أول نتيجة ناجحة من جديد* (الهيدر `Idempotent-Replayed: true`) وما بيحجز مرتين؛ ونفس المفتاح مع طلب *مختلف* بيعطي `422 IDEMPOTENCY_KEY_REUSED`؛ وإذا الطلب الأول لساته شغّال بيجيك `409 IDEMPOTENCY_IN_PROGRESS`. الفشل ما بينحفظ — صلّح الطلب وابعته من جديد. المفاتيح بتنمسح بعد 24 ساعة.
- **حد الطلبات.** 20 طلب بالثانية لكل محل وبحد أقصى 40 دفعة وحدة. كل جواب فيه `RateLimit-Policy` و`RateLimit`؛ وإذا تخطيت الحد بيجيك `429` مع `Retry-After`.
- **الوقت.** الأوقات اللي بتقراها بتوقيت UTC (`start_at`)؛ و`local_date` / `local_time` / `label_ar` بتوقيت المحل (`Asia/Amman`، UTC+3 طول السنة).

## 8. إعداد محل كامل من الـ API

بتقدر تعمل كل اللي بتعمله اللوحة (وصاحب المحل كمان بيقدر من اللوحة). أيام الأسبوع مرقّمة **0 = الأحد … 6 = السبت**. الـ `DELETE` ما بيمسح: بيطفي العنصر (`active: false`) و`PATCH {"active": true}` بيرجّعه؛ وبيترفض (`409 HAS_UPCOMING_BOOKINGS`) طالما في زيارة مؤكدة ما خلصت بعد.

```bash
# خدمة (aliases = طرق ثانية بيقولها الزبائن)
curl -s "$BASE/services" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name_ar":"صيانة ثلاجة","aliases":["ثلاجة","براد"],"duration_min":60}'
# منطقة مع رسوم الزيارة (للمحلات اللي بتروح للزبون فقط)
curl -s "$BASE/zones" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name_ar":"الهاشمي الشمالي","aliases":["هاشمي"],"visit_fee_jod":10}'
# فني بيعمل هالخدمة بهالمنطقة؛ بدون "hours" = السبت–الخميس 09:00–18:00
curl -s "$BASE/staff" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name_ar":"محمود العلي","service_ids":["<service id>"],"zone_ids":["<zone id>"]}'
# دوامه: الأحد على فترتين، الجمعة إجازة
curl -s -X PUT "$BASE/staff/<staff id>/hours" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"hours":[{"weekday":0,"start":"09:00","end":"13:00"},{"weekday":0,"start":"16:00","end":"20:00"},{"weekday":6,"start":"09:00","end":"18:00"}]}'
# إجازة لكل المحل (التواريخ شاملة)، أو لفني واحد مع "staff_id"
curl -s "$BASE/days-off" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"date_from":"2026-11-05","date_to":"2026-11-06","reason":"إجازة"}'
# القواعد: slot_step_min، gap_min (فاصل الطريق)، min_lead_min، horizon_days، change_cutoff_min، display_digits
curl -s -X PATCH "$BASE/business" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"settings":{"gap_min":30,"display_digits":"latin"}}'
```

## 9. أدوات للـ LLM تبعك

إذا في LLM بيشغّل البوت، هالتعريفات بتقابل الطلبات فوق واحد لواحد (JSON Schema، بتنفع كـ `parameters` بأسلوب OpenAI أو `input_schema` بأسلوب Anthropic). خلّي `display_ar` بنتيجة الأداة عشان النموذج ينقله.

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

## 10. اشياء لازم تعرفها

- `slot_token` موقّع ومربوط بمحلك وصالح **15 دقيقة**. التوكنات رخيصة: اسأل من جديد بدل ما تحتفظ بقديمة.
- `external_ref` (رقم تذكرتك) **فريد لكل محل**؛ حجز أو تعديل برقم مستعمل بيعطي `422 INVALID_INPUT`.
- الأوقات بتنعرض كل 30 دقيقة افتراضياً، وما بتكون أبكر من ساعتين من هلأ ولا أبعد من 14 يوم (وكلها قابلة للتعديل لكل محل).
- قوائم النتائج بترجّع أول 100 نتيجة.
- الحجوزات اللي بيعملها صاحب المحل من اللوحة شكلها نفس حجوزاتك (`source: "panel"`) وبتطلّع `booking.created` كمان.
