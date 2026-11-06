/* The public API as an OpenAPI 3.1 document. /docs/openapi.json serves it, /docs/postman.json is made from it, and a test
 * checks that it lists exactly the routes the server has under /v1. */

type Json = Record<string, unknown>;

const ERROR_CODES = [
  "INVALID_INPUT", "UNAUTHORIZED", "NOT_FOUND", "ZONE_NOT_FOUND", "ZONE_NOT_COVERED", "SERVICE_NOT_FOUND", "SLOT_TAKEN",
  "SLOT_TOKEN_EXPIRED", "TOO_LATE_TO_CHANGE", "INVALID_TRANSITION", "HAS_UPCOMING_BOOKINGS", "INVALID_PHONE",
  "IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_IN_PROGRESS", "FORBIDDEN", "RATE_LIMITED", "SERVER_ERROR",
];

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string, extra: Json = {}) => ({ type: "string", ...(description && { description }), ...extra });
const nullableStr = (description?: string) => ({ type: ["string", "null"], ...(description && { description }) });
const uuid = (description?: string) => str(description, { format: "uuid" });
const int = (description?: string, extra: Json = {}) => ({ type: "integer", ...(description && { description }), ...extra });
const obj = (properties: Json, required: string[] = []) => ({ type: "object", properties, ...(required.length && { required }) });

/** `{ ok: true, data, display_ar, request_id }` */
const envelope = (data: Json, displayAr = "Ready-to-send Jordanian Arabic text for the customer.") => ({
  type: "object",
  required: ["ok", "data", "display_ar", "request_id"],
  properties: {
    ok: { const: true },
    data,
    display_ar: nullableStr(displayAr),
    request_id: str("Quote this when asking for support.", { example: "req_0f272e7014ead2bb" }),
  },
});
const setupEnvelope = (data: Json) => envelope(data, "Always null for setup calls: they are for developers, not for customers.");

const jsonBody = (schema: Json, example?: Json) => ({
  required: true,
  content: { "application/json": { schema, ...(example && { example }) } },
});
const okResponse = (description: string, schema: Json) => ({ description, content: { "application/json": { schema } } });

const ERROR_TEXT: Record<string, string> = {
  "401": "Missing, wrong or replaced API key (`UNAUTHORIZED`).",
  "404": "Not found, or it belongs to another business (`NOT_FOUND`).",
  "409": "Conflict: `SLOT_TAKEN`, `TOO_LATE_TO_CHANGE`, `INVALID_TRANSITION`, `HAS_UPCOMING_BOOKINGS` or `IDEMPOTENCY_IN_PROGRESS`.",
  "422": "Invalid input (`INVALID_INPUT`, `INVALID_PHONE`, `SERVICE_NOT_FOUND`, `ZONE_NOT_FOUND`, `ZONE_NOT_COVERED`, `SLOT_TOKEN_EXPIRED`, `IDEMPOTENCY_KEY_REUSED`).",
  "429": "Rate limit exceeded (`RATE_LIMITED`); see `Retry-After`.",
};
const errors = (...statuses: number[]) =>
  Object.fromEntries([401, ...statuses, 429].map((s) => [String(s), { description: ERROR_TEXT[String(s)]!, content: { "application/json": { schema: ref("Error") } } }]));

const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const idemHeader = {
  name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", minLength: 1, maxLength: 255 },
  description: "Makes the request safe to retry: the same key with the same request returns the first successful result and never repeats it. Kept 24 hours.",
};
const query = (name: string, description: string, schema: Json = { type: "string" }, required = false) => ({ name, in: "query", required, description, schema });

interface Op {
  method: "get" | "post" | "patch" | "put" | "delete";
  path: string;
  tag: string;
  summary: string;
  description?: string;
  operationId: string;
  parameters?: Json[];
  body?: Json;
  responses: Json;
  /** For the Postman collection: a test script that saves values into collection variables. */
  postmanTest?: string[];
}

const ops: Op[] = [];
const add = (op: Op) => ops.push(op);

// ---------------------------------------------------------------------------------------------------------------------
// Booking flow
// ---------------------------------------------------------------------------------------------------------------------
add({
  method: "get", path: "/availability", tag: "Booking flow", operationId: "findSlots",
  summary: "Free times (the 2–3 options to show the customer)",
  description:
    "Returns up to `limit` free times, spread over different parts of the day and different days. Send the service and the zone **as the customer wrote them** " +
    "(\"ثلاجة\", \"هاشمي شمالي\") or by id. `display_ar` is the ready message listing the options. Pass the chosen `slot_token` to `POST /bookings`. " +
    "A token is valid for 15 minutes.",
  parameters: [
    query("service", "Service name, alias or id.", { type: "string" }, true),
    query("zone", "Zone name, alias or id (businesses that go to the customer).", { type: "string" }),
    query("date_from", "First local date, `yyyy-MM-dd`. Default: today.", { type: "string", format: "date" }),
    query("date_to", "Last local date. Default: 3 days after `date_from` (at most 31 days).", { type: "string", format: "date" }),
    query("limit", "How many options (1–20, default 3).", { type: "integer", minimum: 1, maximum: 20, default: 3 }),
    query("booking_id", "Set when rescheduling: that booking's own time and travel gap count as free.", { type: "string", format: "uuid" }),
  ],
  responses: {
    "200": okResponse("The options (an empty `slots` list is not an error).", envelope(obj({
      service: obj({ id: uuid(), name_ar: str(), duration_min: int() }),
      zone: { oneOf: [obj({ id: uuid(), name_ar: str(), visit_fee_jod: nullableStr("e.g. \"10.000\"") }), { type: "null" }] },
      slots: { type: "array", items: ref("Slot") },
    }))),
    ...errors(422),
  },
  postmanTest: ['const slots = (pm.response.json().data || {}).slots || [];', 'if (slots.length) pm.collectionVariables.set("slot_token", slots[0].slot_token);'],
});

add({
  method: "post", path: "/availability/check", tag: "Booking flow", operationId: "checkTime",
  summary: "\"Can he come at 5?\" — is one specific time free, and if not, the nearest alternatives",
  description:
    "Send **either** `start_at` **or** both `date` and `time`.\n\n" +
    "`date`: `2026-11-08` (any digit script), `اليوم`, `بكرا`, `بعد بكرا`, `today`, `tomorrow`.\n\n" +
    "`time`: `17:00`, `5`, `٥`, `5 المسا`, `ع الخمسة`, `الساعة خمسة ونص`, `5 ونص`, `5 وربع`, `6 إلا ربع`, `5pm`, `1 الظهر`, `9 بالليل`. " +
    "A bare hour 1–7 means afternoon, 8–11 morning.\n\n" +
    "When `available` is false, `reason_code` is one of `TOO_SOON`, `BEYOND_HORIZON`, `CLOSURE`, `DAY_OFF`, `OUTSIDE_WORKING_HOURS`, `NOT_A_SLOT_TIME`, `FULLY_BOOKED`, " +
    "and `alternatives` holds up to 3 nearby free times (same day first).",
  body: jsonBody(
    obj({
      service: str("Service name, alias or id."), zone: str("Zone name, alias or id."), date: str(), time: str(),
      start_at: str("ISO 8601 with offset.", { format: "date-time" }), booking_id: uuid("Set when rescheduling."),
    }, ["service"]),
    { service: "ثلاجة", zone: "هاشمي شمالي", date: "بكرا", time: "ع الخمسة" },
  ),
  responses: {
    "200": okResponse("Available or not.", envelope(obj({
      available: { type: "boolean" },
      reason_code: { type: ["string", "null"], enum: ["TOO_SOON", "BEYOND_HORIZON", "CLOSURE", "DAY_OFF", "OUTSIDE_WORKING_HOURS", "NOT_A_SLOT_TIME", "FULLY_BOOKED", null] },
      requested: obj({ local_date: str(), local_time: str() }),
      slot_token: nullableStr("Filled when available: book it with `POST /bookings`."),
      slot: { oneOf: [ref("Slot"), { type: "null" }] },
      alternatives: { type: "array", items: ref("Slot") },
    }))),
    ...errors(422),
  },
  postmanTest: ['const d = pm.response.json().data || {};', 'if (d.slot_token) pm.collectionVariables.set("slot_token", d.slot_token);'],
});

add({
  method: "post", path: "/bookings", tag: "Booking flow", operationId: "createBooking",
  summary: "Book the chosen slot (call it only after the customer confirmed)",
  description:
    "There is no \"hold\": your bot shows the summary and books when the customer taps confirm. If the time was taken in the meantime the answer is `409 SLOT_TAKEN` " +
    "with `error.alternatives` and a ready `display_ar`. If the chosen staff member just got busy but another is free at that exact time, the booking goes to the other one. " +
    "Send an `Idempotency-Key` so a retry after a timeout cannot fail or double-book.",
  parameters: [idemHeader],
  body: jsonBody(
    obj({
      slot_token: str("From `/availability` or `/availability/check`."),
      customer_name: str(), customer_phone: str("Any way of writing a Jordanian mobile: 0791234567, +962791234567, 00962…, Arabic digits…"),
      description: str("e.g. \"ثلاجة LG — ما بتبرد\""), address: str(), external_ref: str("Your own id, e.g. SR-2026-000009. Unique per business."),
    }, ["slot_token", "customer_name", "customer_phone"]),
    { slot_token: "{{slot_token}}", customer_name: "سامر", customer_phone: "0795550100", description: "ثلاجة LG — ما بتبرد", external_ref: "SR-2026-000009" },
  ),
  responses: {
    "201": okResponse("Booked.", envelope(ref("Booking"))),
    ...errors(409, 422),
  },
  postmanTest: ['const d = (pm.response.json().data || {});', 'if (d.id) pm.collectionVariables.set("booking_id", d.id);'],
});

add({
  method: "get", path: "/bookings", tag: "Booking flow", operationId: "listBookings",
  summary: "Find bookings (by phone, your reference, status, dates)",
  description: "Oldest visit first, all statuses unless `status` is given. `display_ar` marks cancelled / finished ones. Up to `limit` (max 100).",
  parameters: [
    query("phone", "Any way of writing the number."), query("external_ref", "Your reference."),
    query("status", "Only this status.", { type: "string", enum: ["confirmed", "completed", "cancelled", "no_show"] }),
    query("from", "First local date.", { type: "string", format: "date" }), query("to", "Last local date (inclusive).", { type: "string", format: "date" }),
    query("limit", "1–100, default 50.", { type: "integer", minimum: 1, maximum: 100, default: 50 }),
  ],
  responses: { "200": okResponse("The bookings.", envelope(obj({ bookings: { type: "array", items: ref("Booking") } }))), ...errors(422) },
});

add({
  method: "get", path: "/bookings/{id}", tag: "Booking flow", operationId: "getBooking", summary: "One booking, with its history",
  parameters: [idParam], responses: { "200": okResponse("The booking.", envelope(ref("BookingWithHistory"))), ...errors(404) },
});

add({
  method: "patch", path: "/bookings/{id}", tag: "Booking flow", operationId: "editBooking",
  summary: "Fix customer data (name, phone, description, address, your reference)",
  description: "Any subset; `null` clears description, address and external_ref. Unknown fields are refused. Allowed in any status.",
  parameters: [idParam],
  body: jsonBody(obj({
    customer_name: str(), customer_phone: str(), description: nullableStr(), address: nullableStr(), external_ref: nullableStr(),
  }), { description: "ثلاجة LG — ما بتبرد", external_ref: "SR-2026-000010" }),
  responses: { "200": okResponse("Updated.", envelope(ref("Booking"))), ...errors(404, 422) },
});

add({
  method: "post", path: "/bookings/{id}/reschedule", tag: "Booking flow", operationId: "rescheduleBooking",
  summary: "Move a booking to another slot",
  description:
    "Get the new `slot_token` from `/availability` or `/availability/check` **with `booking_id`**, otherwise the booking's own time blocks the neighbouring slots (\"an hour later\"). " +
    "Refused with `TOO_LATE_TO_CHANGE` when the visit starts in less than 2 hours (per business setting `change_cutoff_min`). On `SLOT_TAKEN` the booking stays where it was.",
  parameters: [idParam, idemHeader],
  body: jsonBody(obj({ slot_token: str() }, ["slot_token"]), { slot_token: "{{slot_token}}" }),
  responses: { "200": okResponse("Moved.", envelope(ref("Booking"))), ...errors(404, 409, 422) },
});

add({
  method: "post", path: "/bookings/{id}/cancel", tag: "Booking flow", operationId: "cancelBooking",
  summary: "Cancel a booking",
  description: "Cancelling an already cancelled booking is a harmless 200. Same 2-hour rule as rescheduling.",
  parameters: [idParam, idemHeader],
  body: jsonBody(obj({ reason: str() }), { reason: "الزبون غيّر رأيه" }),
  responses: { "200": okResponse("Cancelled.", envelope(ref("Booking"))), ...errors(404, 409) },
});

add({
  method: "post", path: "/bookings/{id}/status", tag: "Booking flow", operationId: "setBookingStatus",
  summary: "Mark a visit completed or no-show",
  description: "Only from `confirmed`. Repeating the same status is a 200.",
  parameters: [idParam, idemHeader],
  body: jsonBody(obj({ status: { type: "string", enum: ["completed", "no_show"] } }, ["status"]), { status: "completed" }),
  responses: { "200": okResponse("Updated.", envelope(ref("Booking"))), ...errors(404, 409, 422) },
});

// ---------------------------------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------------------------------
const businessSettings = obj({
  slot_step_min: int("Candidate start times every N minutes (5–120).", { default: 30 }),
  gap_min: int("Travel gap kept free after each booking (0–240).", { default: 30 }),
  min_lead_min: int("Earliest booking = now + this.", { default: 120 }),
  horizon_days: int("Furthest booking.", { default: 14 }),
  change_cutoff_min: int("Reschedule / cancel through the API until this many minutes before the visit.", { default: 120 }),
  display_digits: { type: "string", enum: ["latin", "arabic"], default: "latin" },
});
const includeInactive = query("include_inactive", "Also list items that were switched off.", { type: "string", enum: ["true", "false"] });
const listOf = (key: string, schema: string) => okResponse("The list.", setupEnvelope(obj({ [key]: { type: "array", items: ref(schema) } })));
const oneOf = (description: string, schema: string) => okResponse(description, setupEnvelope(ref(schema)));
const deleteNote = "Does not erase: the item is switched off (`active: false`) so past bookings keep pointing at it; `PATCH {\"active\": true}` brings it back. Refused with `HAS_UPCOMING_BOOKINGS` while a confirmed visit that has not ended still depends on it.";

add({
  method: "get", path: "/business", tag: "Setup", operationId: "getBusiness", summary: "The business, its effective settings and its webhook",
  responses: { "200": okResponse("The business.", setupEnvelope(ref("Business"))), ...errors() },
});
add({
  method: "patch", path: "/business", tag: "Setup", operationId: "updateBusiness",
  summary: "Change settings and/or the webhook URL",
  description:
    "`webhook_url` must be `https://`, without credentials, and must not point to localhost or a private network. The first URL creates the signing secret (`webhook_secret`); " +
    "changing the URL keeps it; `null` removes both (setting a URL again gives a new secret).",
  body: jsonBody(obj({ settings: businessSettings, webhook_url: nullableStr() }), { settings: { slot_step_min: 30 }, webhook_url: "https://bot.example.com/hooks/booking" }),
  responses: { "200": okResponse("Updated.", setupEnvelope(ref("Business"))), ...errors(422) },
});

add({ method: "get", path: "/staff", tag: "Setup", operationId: "listStaff", summary: "Staff (technicians, doctors, barbers…)", parameters: [includeInactive], responses: { "200": listOf("staff", "Staff"), ...errors() } });
add({
  method: "post", path: "/staff", tag: "Setup", operationId: "createStaff", summary: "Add a staff member",
  description: "Without `hours` they get the default week: Saturday–Thursday 09:00–18:00.",
  parameters: [idemHeader],
  body: jsonBody(obj({
    name_ar: str(), name_en: nullableStr(), phone: nullableStr(), color: str("#RRGGBB"),
    service_ids: { type: "array", items: uuid() }, zone_ids: { type: "array", items: uuid() }, hours: { type: "array", items: ref("WorkingInterval") },
  }, ["name_ar"]), { name_ar: "محمود العلي", service_ids: [], zone_ids: [] }),
  responses: { "201": oneOf("Created.", "Staff"), ...errors(422) },
});
add({ method: "get", path: "/staff/{id}", tag: "Setup", operationId: "getStaff", summary: "One staff member", parameters: [idParam], responses: { "200": oneOf("The staff member.", "Staff"), ...errors(404) } });
add({
  method: "patch", path: "/staff/{id}", tag: "Setup", operationId: "updateStaff", summary: "Edit a staff member",
  description: "`service_ids` / `zone_ids` replace the whole list. Hours are changed with `PUT /staff/{id}/hours`.",
  parameters: [idParam],
  body: jsonBody(obj({
    name_ar: str(), name_en: nullableStr(), phone: nullableStr(), color: str(), active: { type: "boolean" },
    service_ids: { type: "array", items: uuid() }, zone_ids: { type: "array", items: uuid() },
  })),
  responses: { "200": oneOf("Updated.", "Staff"), ...errors(404, 409, 422) },
});
add({ method: "delete", path: "/staff/{id}", tag: "Setup", operationId: "deactivateStaff", summary: "Switch a staff member off", description: deleteNote, parameters: [idParam], responses: { "200": oneOf("Switched off.", "Staff"), ...errors(404, 409) } });
add({
  method: "put", path: "/staff/{id}/hours", tag: "Setup", operationId: "setStaffHours", summary: "Replace the weekly working hours",
  description: "`weekday`: **0 = Sunday … 6 = Saturday**. Several intervals per day are allowed (split shift); overlapping ones are refused; `[]` means never works.",
  parameters: [idParam],
  body: jsonBody(obj({ hours: { type: "array", items: ref("WorkingInterval") } }, ["hours"]), { hours: [{ weekday: 6, start: "09:00", end: "18:00" }, { weekday: 0, start: "09:00", end: "13:00" }, { weekday: 0, start: "16:00", end: "20:00" }] }),
  responses: { "200": oneOf("Updated.", "Staff"), ...errors(404, 422) },
});

add({ method: "get", path: "/services", tag: "Setup", operationId: "listServices", summary: "Services", parameters: [includeInactive], responses: { "200": listOf("services", "Service"), ...errors() } });
add({
  method: "post", path: "/services", tag: "Setup", operationId: "createService", summary: "Add a service",
  description: "`aliases` are other ways customers say it (\"ثلاجة\", \"براد\").", parameters: [idemHeader],
  body: jsonBody(obj({ name_ar: str(), name_en: nullableStr(), aliases: { type: "array", items: str() }, duration_min: int("5–720") }, ["name_ar", "duration_min"]), { name_ar: "صيانة ثلاجة", aliases: ["ثلاجة", "براد"], duration_min: 60 }),
  responses: { "201": oneOf("Created.", "Service"), ...errors(422) },
});
add({ method: "get", path: "/services/{id}", tag: "Setup", operationId: "getService", summary: "One service", parameters: [idParam], responses: { "200": oneOf("The service.", "Service"), ...errors(404) } });
add({
  method: "patch", path: "/services/{id}", tag: "Setup", operationId: "updateService", summary: "Edit a service", parameters: [idParam],
  body: jsonBody(obj({ name_ar: str(), name_en: nullableStr(), aliases: { type: "array", items: str() }, duration_min: int(), active: { type: "boolean" } })),
  responses: { "200": oneOf("Updated.", "Service"), ...errors(404, 409, 422) },
});
add({ method: "delete", path: "/services/{id}", tag: "Setup", operationId: "deactivateService", summary: "Switch a service off", description: deleteNote, parameters: [idParam], responses: { "200": oneOf("Switched off.", "Service"), ...errors(404, 409) } });

add({ method: "get", path: "/zones", tag: "Setup", operationId: "listZones", summary: "Zones (only for businesses that go to the customer)", parameters: [includeInactive], responses: { "200": listOf("zones", "Zone"), ...errors() } });
add({
  method: "post", path: "/zones", tag: "Setup", operationId: "createZone", summary: "Add a zone",
  description: "Businesses with `goes_to_customer: false` have no zones (`422`).", parameters: [idemHeader],
  body: jsonBody(obj({ name_ar: str(), name_en: nullableStr(), aliases: { type: "array", items: str() }, visit_fee_jod: { type: ["number", "string", "null"], description: "Visit fee in JOD." } }, ["name_ar"]), { name_ar: "الهاشمي الشمالي", aliases: ["هاشمي"], visit_fee_jod: 10 }),
  responses: { "201": oneOf("Created.", "Zone"), ...errors(422) },
});
add({ method: "get", path: "/zones/{id}", tag: "Setup", operationId: "getZone", summary: "One zone", parameters: [idParam], responses: { "200": oneOf("The zone.", "Zone"), ...errors(404) } });
add({
  method: "patch", path: "/zones/{id}", tag: "Setup", operationId: "updateZone", summary: "Edit a zone", parameters: [idParam],
  body: jsonBody(obj({ name_ar: str(), name_en: nullableStr(), aliases: { type: "array", items: str() }, visit_fee_jod: { type: ["number", "string", "null"] }, active: { type: "boolean" } })),
  responses: { "200": oneOf("Updated.", "Zone"), ...errors(404, 409, 422) },
});
add({ method: "delete", path: "/zones/{id}", tag: "Setup", operationId: "deactivateZone", summary: "Switch a zone off", description: deleteNote, parameters: [idParam], responses: { "200": oneOf("Switched off.", "Zone"), ...errors(404, 409) } });

add({
  method: "get", path: "/days-off", tag: "Setup", operationId: "listDaysOff", summary: "Days off that have not ended yet",
  parameters: [query("staff_id", "Only this staff member's days off.", { type: "string", format: "uuid" }), query("from", "Local date; default today.", { type: "string", format: "date" }), query("to", "Local date.", { type: "string", format: "date" })],
  responses: { "200": listOf("days_off", "DayOff"), ...errors(422) },
});
add({
  method: "post", path: "/days-off", tag: "Setup", operationId: "createDayOff", summary: "Add a day off (whole business, or one staff member)",
  description: "Send **either** `date_from` + `date_to` (local dates, inclusive, whole days) **or** `start_at` + `end_at` (ISO 8601, part of a day). Omit `staff_id` for the whole business. Existing bookings are not touched.",
  parameters: [idemHeader],
  body: jsonBody(obj({ staff_id: uuid(), reason: str(), date_from: str(undefined, { format: "date" }), date_to: str(undefined, { format: "date" }), start_at: str(undefined, { format: "date-time" }), end_at: str(undefined, { format: "date-time" }) }), { date_from: "2026-11-05", date_to: "2026-11-06", reason: "إجازة" }),
  responses: { "201": oneOf("Created.", "DayOff"), ...errors(422) },
});
add({
  method: "delete", path: "/days-off/{id}", tag: "Setup", operationId: "deleteDayOff", summary: "Remove a day off (this one really deletes)",
  parameters: [idParam], responses: { "200": okResponse("Removed.", setupEnvelope(obj({ id: uuid(), deleted: { const: true } }))), ...errors(404) },
});

// ---------------------------------------------------------------------------------------------------------------------
// Components and document
// ---------------------------------------------------------------------------------------------------------------------
const bookingProps = {
  id: uuid(), status: { type: "string", enum: ["confirmed", "completed", "cancelled", "no_show"] },
  start_at: str(undefined, { format: "date-time" }), end_at: str(undefined, { format: "date-time" }),
  staff_id: uuid(), service_id: uuid(), zone_id: { oneOf: [uuid(), { type: "null" }] },
  customer_name: str(), customer_phone: str("E.164, e.g. +962795550100"), description: nullableStr(), address: nullableStr(),
  external_ref: nullableStr(), visit_fee_jod: nullableStr("The zone's fee when booked, e.g. \"10.000\""),
  source: { type: "string", enum: ["api", "panel"] }, created_at: str(undefined, { format: "date-time" }),
  label_ar: str("e.g. \"الأحد 8 تشرين الثاني، الساعة 9 الصبح\""),
};

const schemas: Json = {
  Error: obj({
    ok: { const: false },
    error: obj({
      code: { type: "string", enum: ERROR_CODES },
      message: str("For developers (English)."),
      display_ar: nullableStr("Ready-to-send Arabic text, or null when the error is not for the customer."),
      fields: { type: "array", items: obj({ path: str(), message: str() }) },
      alternatives: { type: "array", items: ref("Slot"), description: "With `SLOT_TAKEN`: the nearest free times." },
    }, ["code", "message", "display_ar"]),
    request_id: str(),
  }, ["ok", "error", "request_id"]),
  Slot: obj({
    slot_token: str("Pass it to `POST /bookings` (valid 15 minutes)."), start_at: str(undefined, { format: "date-time" }), end_at: str(undefined, { format: "date-time" }),
    local_date: str(), local_time: str("HH:mm in the business's time zone"), part_of_day: { type: "string", enum: ["morning", "noon", "afternoon", "evening"] },
    staff_id: uuid(), label_ar: str("e.g. \"الأحد 8 تشرين الثاني، الساعة 9 الصبح\" — handy for your own confirmation summary."),
  }),
  Booking: obj(bookingProps),
  BookingWithHistory: { allOf: [ref("Booking"), obj({ history: { type: "array", items: obj({ action: str(), by: { type: "string", enum: ["api", "business", "admin"] }, at: str(undefined, { format: "date-time" }), data: { type: "object" } }) } })] },
  WorkingInterval: obj({ weekday: int("0 = Sunday … 6 = Saturday", { minimum: 0, maximum: 6 }), start: str("HH:mm"), end: str("HH:mm") }, ["weekday", "start", "end"]),
  Staff: obj({ id: uuid(), name_ar: str(), name_en: nullableStr(), phone: nullableStr(), color: str(), active: { type: "boolean" }, service_ids: { type: "array", items: uuid() }, zone_ids: { type: "array", items: uuid() }, hours: { type: "array", items: ref("WorkingInterval") } }),
  Service: obj({ id: uuid(), name_ar: str(), name_en: nullableStr(), aliases: { type: "array", items: str() }, duration_min: int(), active: { type: "boolean" } }),
  Zone: obj({ id: uuid(), name_ar: str(), name_en: nullableStr(), aliases: { type: "array", items: str() }, visit_fee_jod: nullableStr(), active: { type: "boolean" } }),
  DayOff: obj({ id: uuid(), staff_id: { oneOf: [uuid(), { type: "null" }] }, start_at: str(undefined, { format: "date-time" }), end_at: str(undefined, { format: "date-time" }), reason: nullableStr() }),
  Business: obj({
    name: str(), timezone: str(), goes_to_customer: { type: "boolean" }, staff_label_ar: str(), staff_label_en: str(),
    webhook_url: nullableStr(), webhook_secret: nullableStr("`whsec_…` — verify webhooks with it."), settings: businessSettings,
  }),
  WebhookEvent: obj({
    id: str("`evt_<uuid>` (the same uuid as in the `webhook-id` header)."),
    type: { type: "string", enum: ["booking.created", "booking.updated", "booking.cancelled"] },
    created_at: str(undefined, { format: "date-time" }),
    actor: { type: "string", enum: ["api", "business", "admin"], description: "`api` = a call made with your own key (you can ignore these)." },
    data: obj({
      booking: ref("Booking"),
      change: { type: "string", enum: ["rescheduled", "edited", "completed", "no_show"], description: "Only on `booking.updated`." },
      previous: obj({ start_at: str(undefined, { format: "date-time" }), staff_id: uuid() }),
      reason: nullableStr("Only on `booking.cancelled`."),
      display_ar: nullableStr("Ready message for the customer; null for edits, completed and no-show."),
      template: obj({ customer_name: str(), date: str(), time: str(), zone: nullableStr() }),
    }),
  }),
};

const webhookOperation = (summary: string, description: string) => ({
  post: {
    summary, description, operationId: `webhook_${summary.replace(/\W+/g, "_")}`, tags: ["Webhooks"],
    parameters: [
      { name: "webhook-id", in: "header", required: true, schema: { type: "string" }, description: "`msg_<uuid>`, identical for every retry: use it to ignore duplicates." },
      { name: "webhook-timestamp", in: "header", required: true, schema: { type: "string" }, description: "Unix seconds. Reject if far from your clock." },
      { name: "webhook-signature", in: "header", required: true, schema: { type: "string" }, description: "`v1,` + base64 HMAC-SHA256 over `<id>.<timestamp>.<raw body>` with the base64-decoded `webhook_secret`." },
    ],
    requestBody: jsonBody(ref("WebhookEvent")),
    responses: { "200": { description: "Any 2xx within 10 seconds means delivered. Anything else is retried (5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h)." } },
  },
});

export const OPERATIONS = ops;

/** `{id}` → `:id`, the way the server registers it. */
export const documentedRoutes = () => ops.map((o) => `${o.method.toUpperCase()} /v1${o.path.replace(/\{(\w+)\}/g, ":$1")}`);

export function buildOpenApi(baseUrl = "https://api.example.com"): Json {
  const paths: Record<string, Json> = {};
  for (const op of ops) {
    paths[op.path] ??= {};
    paths[op.path]![op.method] = {
      tags: [op.tag], summary: op.summary, operationId: op.operationId,
      ...(op.description && { description: op.description }),
      ...(op.parameters && { parameters: op.parameters }),
      ...(op.body && { requestBody: op.body }),
      responses: op.responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Mawid Booking API",
      version: "1.0.0",
      summary: "Calendar and booking engine for appointment businesses, built for chatbots.",
      description:
        "Every business has its own **API key**; the key alone says which business a request is for. Same base URL for everyone.\n\n" +
        "**Every answer** is `{ ok, data, display_ar, request_id }` (or `{ ok: false, error, request_id }`): `data` is for your code, `display_ar` is a ready-to-send Jordanian Arabic message.\n\n" +
        "**Time** is the business's time zone (`Asia/Amman`); `start_at` / `end_at` are UTC. **Phone numbers** are accepted in any Jordanian format and returned as E.164. " +
        "**Rate limit**: 20 requests/second per business, bursts of 40 (`RateLimit` headers, `429` + `Retry-After`). " +
        "**Retries**: send `Idempotency-Key` on `POST`s.\n\n" +
        "The bot flow: `GET /availability` → show `display_ar` → (\"ما بيجي ع الخمسة؟\" → `POST /availability/check`) → show your summary → `POST /bookings` after the customer confirms. " +
        "Webhooks tell you about changes you did not make.\n\n" +
        "[Integration guide (English)](/docs/guide/en) · [دليل الربط بالعربي](/docs/guide/ar) · [Postman collection](/docs/postman.json)",
    },
    servers: [{ url: `${baseUrl}/v1`, description: "Production" }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Booking flow", description: "What the bot calls during a conversation." },
      { name: "Setup", description: "Staff, services, zones, days off, settings — everything a business needs, also available in the panel." },
      { name: "Webhooks", description: "Events we send to your `webhook_url`." },
    ],
    paths,
    webhooks: {
      "booking.created": webhookOperation("A booking was created", "Sent when a booking is created (by you through the API, or by the business in its panel)."),
      "booking.updated": webhookOperation("A booking was changed", "`data.change` says what: `rescheduled`, `edited`, `completed` or `no_show`."),
      "booking.cancelled": webhookOperation("A booking was cancelled", "If the business cancelled it, `display_ar` apologises to the customer."),
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "`Authorization: Bearer bk_live_…` (or `bk_test_…` for a test business)." } },
      schemas,
    },
  };
}

/** A Postman v2.1 collection made from the same operations. */
export function buildPostman(baseUrl = "https://api.example.com"): Json {
  const folders = new Map<string, Json[]>();
  for (const op of ops) {
    const pathVars = op.path.replace(/\{id\}/g, "{{booking_id}}");
    const example = (op.body as { content?: { "application/json"?: { example?: Json } } } | undefined)?.content?.["application/json"]?.example;
    const queryItems = (op.parameters ?? []).filter((p) => (p as { in?: string }).in === "query").map((p) => ({
      key: (p as { name: string }).name, value: "", description: (p as { description?: string }).description, disabled: !(p as { required?: boolean }).required,
    }));
    const headers = [
      { key: "Content-Type", value: "application/json" },
      ...(op.parameters ?? []).filter((p) => (p as { in?: string }).in === "header").map((p) => ({ key: (p as { name: string }).name, value: "{{$guid}}", description: "Retry-safety key", disabled: true })),
    ];
    const item: Json = {
      name: `${op.method.toUpperCase()} ${op.path} — ${op.summary}`,
      request: {
        method: op.method.toUpperCase(),
        header: headers,
        url: { raw: `{{base_url}}/v1${pathVars}`, host: ["{{base_url}}"], path: ["v1", ...pathVars.split("/").filter(Boolean)], query: queryItems },
        description: op.description,
        ...(example && { body: { mode: "raw", raw: JSON.stringify(example, null, 2), options: { raw: { language: "json" } } } }),
      },
      ...(op.postmanTest && { event: [{ listen: "test", script: { type: "text/javascript", exec: op.postmanTest } }] }),
    };
    folders.set(op.tag, [...(folders.get(op.tag) ?? []), item]);
  }
  return {
    info: {
      name: "Mawid Booking API",
      description: "Set `base_url` and `api_key` (collection variables), then run Booking flow top to bottom: slots are saved into `slot_token` and `booking_id` automatically.",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{api_key}}", type: "string" }] },
    variable: [
      { key: "base_url", value: baseUrl },
      { key: "api_key", value: "bk_test_PASTE_YOUR_KEY" },
      { key: "slot_token", value: "" },
      { key: "booking_id", value: "" },
    ],
    item: [...folders.entries()].map(([name, item]) => ({ name, item })),
  };
}
