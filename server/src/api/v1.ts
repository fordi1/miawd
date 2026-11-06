import type { FastifyInstance, FastifyRequest } from "fastify";
import { DateTime } from "luxon";
import type pg from "pg";
import { z } from "zod";
import { authenticate, type AuthedBusiness } from "../auth/apiKey.js";
import { explainUnavailable } from "../availability/explain.js";
import { findSlots, nearestSlots, pickSpread, type Slot } from "../availability/findSlots.js";
import { BookingError, createBooking, type Booking } from "../bookings/createBooking.js";
import { bookingJson } from "../bookings/serialize.js";
import {
  cancelBooking,
  getBooking,
  getHistory,
  listBookings,
  patchBooking,
  rescheduleBooking,
  setBookingStatus,
  type BookingPatch,
  type BookingRecord,
  type BookingStatus,
} from "../bookings/manage.js";
import { dayPhraseAr, fullDateAr, timePhraseAr } from "../i18n/arabic.js";
import { parseDateText, parseTimeText } from "../i18n/parseWhen.js";
import { normalizeJordanMobile } from "../lib/phone.js";
import { registerCatalogRoutes } from "./catalogRoutes.js";
import type { TokenBuckets } from "./rateLimit.js";
import { envelope, isoDate, reply } from "./common.js";
import { ApiError } from "./errors.js";
import { withIdempotency } from "./idempotency.js";
import { findService, findZone, zoneIsCovered, type ServiceRow, type ZoneRow } from "./resolve.js";
import { signSlotToken, verifySlotToken, type SlotTokenPayload } from "./slotToken.js";

declare module "fastify" {
  interface FastifyRequest {
    business?: AuthedBusiness;
  }
}

export interface V1Options {
  apiKeyPepper: string;
  slotTokenSecret: string;
  now: () => Date;
  /** Tests and local development only: webhook URLs may be http and point to this machine. */
  webhookAllowLocal: boolean;
  limiter: TokenBuckets;
}



const availabilityQuery = z.object({
  service: z.string().trim().min(1),
  zone: z.string().trim().min(1).optional(),
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(3),
  booking_id: z.string().uuid().optional(), // set when rescheduling: this booking's own time counts as free
});

const checkBody = z.object({
  service: z.string().trim().min(1),
  zone: z.string().trim().min(1).optional(),
  date: z.string().trim().min(1).optional(),
  time: z.string().trim().min(1).optional(),
  start_at: z.string().trim().min(1).optional(),
  booking_id: z.string().uuid().optional(),
});

const bookingBody = z.object({
  slot_token: z.string().min(1),
  customer_name: z.string().trim().min(1).max(100),
  customer_phone: z.string().trim().min(1).max(40),
  description: z.string().trim().max(500).optional(),
  address: z.string().trim().max(300).optional(),
  external_ref: z.string().trim().min(1).max(100).optional(),
});

const listQuery = z.object({
  phone: z.string().trim().min(1).optional(),
  external_ref: z.string().trim().min(1).optional(),
  status: z.enum(["confirmed", "completed", "cancelled", "no_show"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const patchBody = z
  .object({
    customer_name: z.string().trim().min(1).max(100).optional(),
    customer_phone: z.string().trim().min(1).max(40).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
    external_ref: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();

const rescheduleBody = z.object({ slot_token: z.string().min(1) });
const cancelBody = z.object({ reason: z.string().trim().max(300).optional() });
const statusBody = z.object({ status: z.enum(["completed", "no_show"]) });

const hm = (localTime: string) => localTime.split(":").map(Number) as [number, number];

/** "A" / "A، أو B" / "A، B، أو C" */
const joinAlternatives = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join("، ")}، أو ${items[items.length - 1]}`;

const STATUS_AR: Record<BookingStatus, string> = {
  confirmed: "مؤكد",
  completed: "منتهي",
  cancelled: "ملغي",
  no_show: "ما تمت الزيارة",
};
const countAr = (n: number) => (n === 1 ? "عندك حجز واحد" : n === 2 ? "عندك حجزين" : n <= 10 ? `عندك ${n} حجوزات` : `عندك ${n} حجز`);

const isSlotTaken = (e: unknown): e is BookingError => e instanceof BookingError && e.code === "SLOT_TAKEN";
const isDuplicateRef = (e: unknown) => (e as { code?: string }).code === "23505";
const duplicateRef = () => new ApiError("INVALID_INPUT", { fields: [{ path: "external_ref", message: "already used by another booking" }] });

export function v1Routes(pool: pg.Pool, opts: V1Options) {
  return async function plugin(app: FastifyInstance) {
    app.addHook("onRequest", async (req, res) => {
      const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const business = key ? await authenticate(pool, key, opts.apiKeyPepper) : null;
      if (!business) throw new ApiError("UNAUTHORIZED");
      req.business = business;

      // One bucket per business; the IETF RateLimit headers tell the client where it stands.
      const taken = opts.limiter.take(business.id);
      res.header("ratelimit-policy", `"default";q=${opts.limiter.perSecond};w=1`);
      res.header("ratelimit", `"default";r=${taken.remaining};t=${taken.resetSec}`);
      if (!taken.allowed) {
        res.header("retry-after", String(taken.retryAfterSec));
        throw new ApiError("RATE_LIMITED");
      }
    });

    registerCatalogRoutes(app, pool, { now: opts.now, webhookAllowLocal: opts.webhookAllowLocal, webhookEditable: true });

    const todayOf = (b: AuthedBusiness) => DateTime.fromJSDate(opts.now(), { zone: b.timezone }).toISODate()!;
    const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

    /** The service (and zone, for businesses that go to the customer) a request is about. */
    async function resolveContext(b: AuthedBusiness, serviceText: string, zoneText?: string) {
      const service: ServiceRow | null = await findService(pool, b.id, serviceText);
      if (!service) throw new ApiError("SERVICE_NOT_FOUND");
      let zone: ZoneRow | null = null;
      if (b.goesToCustomer && zoneText) {
        zone = await findZone(pool, b.id, zoneText);
        if (!zone) throw new ApiError("ZONE_NOT_FOUND");
        if (!(await zoneIsCovered(pool, zone.id))) throw new ApiError("ZONE_NOT_COVERED");
      }
      return { service, zone };
    }

    /** Checks a slot token's signature, age and owner. */
    function readToken(b: AuthedBusiness, text: string): SlotTokenPayload {
      const checked = verifySlotToken(text, opts.slotTokenSecret, opts.now().getTime());
      if ("problem" in checked) {
        if (checked.problem === "expired") throw new ApiError("SLOT_TOKEN_EXPIRED");
        throw new ApiError("INVALID_INPUT", { fields: [{ path: "slot_token", message: "invalid" }] });
      }
      if (checked.payload.businessId !== b.id) {
        throw new ApiError("INVALID_INPUT", { fields: [{ path: "slot_token", message: "invalid" }] });
      }
      return checked.payload;
    }

    const slotJson = (b: AuthedBusiness, slot: Slot, serviceId: string, zoneId: string | null) => {
      const [h, m] = hm(slot.localTime);
      return {
        slot_token: signSlotToken(
          { businessId: b.id, staffId: slot.staffId, serviceId, zoneId, startsAtMs: slot.startsAt.getTime() },
          opts.slotTokenSecret,
          opts.now().getTime(),
        ),
        start_at: slot.startsAt.toISOString(),
        end_at: slot.endsAt.toISOString(),
        local_date: slot.localDate,
        local_time: slot.localTime,
        part_of_day: slot.partOfDay,
        staff_id: slot.staffId,
        label_ar: `${fullDateAr(slot.localDate)}، ${timePhraseAr(h, m)}`,
      };
    };

    /** "اليوم الأحد الساعة 9 الصبح" for one slot. */
    const slotPhrase = (s: Slot, today: string) => {
      const [h, m] = hm(s.localTime);
      return `${dayPhraseAr(s.localDate, today)} ${timePhraseAr(h, m)}`;
    };
    const slotLines = (slots: Slot[], today: string) => slots.map((s, i) => `${i + 1}) ${slotPhrase(s, today)}`).join("\n");

    /** "بكرا الأحد الساعة 9 الصبح" for one booking. */
    const bookingPhrase = (r: BookingRecord, b: AuthedBusiness) => {
      const local = DateTime.fromJSDate(r.startsAt, { zone: b.timezone });
      return `${dayPhraseAr(local.toISODate()!, todayOf(b))} ${timePhraseAr(local.hour, local.minute)}`;
    };

    /**
     * Runs `attempt` for the staff member in the token. If that person just got busy, tries anyone else who is free at
     * exactly that time; if nobody is, answers SLOT_TAKEN with the nearest free times.
     */
    async function placeSlot<T>(
      b: AuthedBusiness,
      token: SlotTokenPayload,
      attempt: (staffId: string) => Promise<T>,
      ignoreBookingId?: string,
    ): Promise<T> {
      try {
        return await attempt(token.staffId);
      } catch (err) {
        if (!isSlotTaken(err)) throw err;

        const localDate = DateTime.fromMillis(token.startsAtMs, { zone: b.timezone }).toISODate()!;
        const search = { businessId: b.id, serviceId: token.serviceId, zoneId: token.zoneId, now: opts.now(), ignoreBookingId };
        const sameTime = (await findSlots(pool, { ...search, fromDate: localDate, toDate: localDate })).find(
          (s) => s.startsAt.getTime() === token.startsAtMs,
        );
        try {
          if (!sameTime) throw err;
          return await attempt(sameTime.staffId);
        } catch (err2) {
          if (!isSlotTaken(err2)) throw err2;

          const until = DateTime.fromISO(localDate).plus({ days: 7 }).toISODate()!;
          const nearest = pickSpread(await findSlots(pool, { ...search, fromDate: localDate, toDate: until }), 3);
          throw new ApiError("SLOT_TAKEN", {
            alternatives: nearest.map((s) => slotJson(b, s, token.serviceId, token.zoneId)),
            displayAr: nearest.length
              ? `للأسف هالموعد انحجز هلأ 😅 هاي أقرب مواعيد فاضية:\n${slotLines(nearest, todayOf(b))}\nأي موعد بناسبك؟`
              : "للأسف هالموعد انحجز هلأ 😅 وما في مواعيد فاضية قريبة، بتحب أشوفلك الأسبوع الجاي؟",
          });
        }
      }
    }

    // ---- GET /v1/availability ------------------------------------------------------------------------------
    app.get("/availability", async (req, res) => {
      const b = req.business!;
      const q = availabilityQuery.parse(req.query);
      const { service, zone } = await resolveContext(b, q.service, q.zone);

      const today = todayOf(b);
      const fromDate = q.date_from ?? today;
      const toDate = q.date_to ?? DateTime.fromISO(fromDate).plus({ days: 3 }).toISODate()!;
      const span = DateTime.fromISO(toDate).diff(DateTime.fromISO(fromDate), "days").days;
      if (span < 0 || span > 30) {
        throw new ApiError("INVALID_INPUT", { fields: [{ path: "date_to", message: "must be on or after date_from, within 31 days" }] });
      }

      const all = await findSlots(pool, {
        businessId: b.id,
        serviceId: service.id,
        zoneId: zone?.id,
        fromDate,
        toDate,
        ignoreBookingId: q.booking_id,
        now: opts.now(),
      });
      const slots = pickSpread(all, q.limit);

      return reply(
        req,
        res,
        200,
        {
          service: { id: service.id, name_ar: service.name_ar, duration_min: service.duration_min },
          zone: zone ? { id: zone.id, name_ar: zone.name_ar, visit_fee_jod: zone.visit_fee_jod } : null,
          slots: slots.map((s) => slotJson(b, s, service.id, zone?.id ?? null)),
        },
        slots.length
          ? `عنا مواعيد فاضية:\n${slotLines(slots, today)}\nأي موعد بناسبك؟`
          : "للأسف ما في مواعيد فاضية بهالأيام، بتحب أشوفلك الأسبوع الجاي؟",
      );
    });

    // ---- POST /v1/availability/check  ("can he come at 5?") -------------------------------------------------
    app.post("/availability/check", async (req, res) => {
      const b = req.business!;
      const q = checkBody.parse(req.body ?? {});
      const { service, zone } = await resolveContext(b, q.service, q.zone);
      const today = todayOf(b);

      let startsAt: Date;
      if (q.start_at) {
        const dt = DateTime.fromISO(q.start_at, { setZone: true });
        if (!dt.isValid) {
          throw new ApiError("INVALID_INPUT", { fields: [{ path: "start_at", message: "must be an ISO 8601 date-time" }] });
        }
        startsAt = dt.toJSDate();
      } else if (q.date && q.time) {
        const date = parseDateText(q.date, today);
        if (!date) {
          throw new ApiError("INVALID_INPUT", {
            fields: [{ path: "date", message: "not understood" }],
            displayAr: "ما فهمت اليوم 🤔 ممكن تقول: اليوم أو بكرا أو تكتب التاريخ كامل؟",
          });
        }
        const time = parseTimeText(q.time);
        if (!time) {
          throw new ApiError("INVALID_INPUT", {
            fields: [{ path: "time", message: "not understood" }],
            displayAr: "ما فهمت الوقت 🤔 ممكن تكتبه مثلاً: 5 المسا؟",
          });
        }
        const pad = (n: number) => String(n).padStart(2, "0");
        startsAt = DateTime.fromISO(`${date}T${pad(time.hour)}:${pad(time.minute)}`, { zone: b.timezone }).toJSDate();
      } else {
        throw new ApiError("INVALID_INPUT", { fields: [{ path: "date", message: "send start_at, or both date and time" }] });
      }

      const local = DateTime.fromJSDate(startsAt, { zone: b.timezone });
      const localDate = local.toISODate()!;
      const zoneId = zone?.id ?? null;
      const search = { businessId: b.id, serviceId: service.id, zoneId, ignoreBookingId: q.booking_id, now: opts.now() };
      const requested = { local_date: localDate, local_time: local.toFormat("HH:mm") };
      const asked = `${dayPhraseAr(localDate, today)} ${timePhraseAr(local.hour, local.minute)}`;

      const sameDay = await findSlots(pool, { ...search, fromDate: localDate, toDate: localDate });
      const exact = sameDay.find((s) => s.startsAt.getTime() === startsAt.getTime());
      if (exact) {
        const slot = slotJson(b, exact, service.id, zoneId);
        return reply(
          req,
          res,
          200,
          { available: true, reason_code: null, requested, slot_token: slot.slot_token, slot, alternatives: [] },
          `تمام، ${asked} متاح ✅ بدك أثبتلك الموعد؟`,
        );
      }

      const reason = await explainUnavailable(pool, { ...search, startsAt });
      const from = localDate < today ? today : localDate;
      const until = DateTime.fromISO(from).plus({ days: 7 }).toISODate()!;
      const nearby = await findSlots(pool, { ...search, fromDate: from, toDate: until });
      const nearest = nearestSlots(nearby, startsAt.getTime(), from, 3);

      return reply(
        req,
        res,
        200,
        {
          available: false,
          reason_code: reason,
          requested,
          slot_token: null,
          slot: null,
          alternatives: nearest.map((s) => slotJson(b, s, service.id, zoneId)),
        },
        nearest.length
          ? `للأسف ${asked} مش متاحة 🙏 أقرب مواعيد فاضية: ${joinAlternatives(nearest.map((s) => slotPhrase(s, today)))}. شو بناسبك؟`
          : `للأسف ${asked} مش متاحة 🙏 وما في مواعيد فاضية قريبة، بتحب أشوفلك الأسبوع الجاي؟`,
      );
    });

    // ---- POST /v1/bookings ----------------------------------------------------------------------------------
    app.post("/bookings", (req, res) =>
      withIdempotency(pool, req, res, async () => {
        const b = req.business!;
        const body = bookingBody.parse(req.body);
        const token = readToken(b, body.slot_token);
        const phone = normalizeJordanMobile(body.customer_phone);
        if (!phone) throw new ApiError("INVALID_PHONE");

        const input = {
          businessId: b.id,
          serviceId: token.serviceId,
          zoneId: token.zoneId,
          startsAt: new Date(token.startsAtMs),
          customerName: body.customer_name,
          customerPhone: phone,
          address: body.address ?? null,
          description: body.description ?? null,
          externalRef: body.external_ref ?? null,
          source: "api" as const,
        };
        const booking: Booking = await placeSlot(b, token, async (staffId) => {
          try {
            return await createBooking(pool, { ...input, staffId });
          } catch (err) {
            throw isDuplicateRef(err) ? duplicateRef() : err;
          }
        });

        const local = DateTime.fromJSDate(booking.startsAt, { zone: b.timezone });
        const when = timePhraseAr(local.hour, local.minute);
        return {
          status: 201,
          body: envelope(
            req,
            {
              id: booking.id,
              status: booking.status,
              start_at: booking.startsAt.toISOString(),
              end_at: booking.endsAt.toISOString(),
              staff_id: booking.staffId,
              service_id: token.serviceId,
              zone_id: booking.zoneId,
              customer_name: body.customer_name,
              customer_phone: phone,
              description: body.description ?? null,
              address: body.address ?? null,
              external_ref: body.external_ref ?? null,
              visit_fee_jod: booking.visitFeeJod,
              label_ar: `${fullDateAr(local.toISODate()!)}، ${when}`,
            },
            `تم تثبيت موعدك ✅ ${fullDateAr(local.toISODate()!)} ${when}. إذا بدك تغيّر أو تلغي احكيلنا هون.`,
          ),
        };
      }),
    );

    // ---- GET /v1/bookings  (find by phone / reference / status / dates) -------------------------------------
    app.get("/bookings", async (req, res) => {
      const b = req.business!;
      const q = listQuery.parse(req.query);
      let phone: string | undefined;
      if (q.phone) {
        const normalized = normalizeJordanMobile(q.phone);
        if (!normalized) throw new ApiError("INVALID_PHONE");
        phone = normalized;
      }
      const day = (date: string) => DateTime.fromISO(date, { zone: b.timezone });

      const found = await listBookings(pool, b.id, {
        phone,
        externalRef: q.external_ref,
        status: q.status,
        from: q.from ? day(q.from).toJSDate() : undefined,
        to: q.to ? day(q.to).plus({ days: 1 }).toJSDate() : undefined,
        limit: q.limit,
      });
      const lines = found
        .map(
          (r, i) =>
            `${i + 1}) ${bookingPhrase(r, b)}${r.description ? ` (${r.description})` : ""}` +
            (r.status === "confirmed" ? "" : ` — ${STATUS_AR[r.status]}`),
        )
        .join("\n");
      return reply(
        req,
        res,
        200,
        { bookings: found.map((r) => bookingJson(r, b.timezone)) },
        found.length ? `${countAr(found.length)}:\n${lines}` : "ما لقيت أي حجز.",
      );
    });

    // ---- GET /v1/bookings/:id ------------------------------------------------------------------------------
    app.get("/bookings/:id", async (req, res) => {
      const b = req.business!;
      const booking = await getBooking(pool, b.id, idOf(req));
      if (!booking) throw new ApiError("NOT_FOUND");
      const entries = await getHistory(pool, booking.id);
      return reply(
        req,
        res,
        200,
        {
          ...bookingJson(booking, b.timezone),
          history: entries.map((h) => ({ action: h.action, by: h.by, at: h.at.toISOString(), data: h.data })),
        },
        `موعدك: ${bookingPhrase(booking, b)}. الحالة: ${STATUS_AR[booking.status]}.`,
      );
    });

    // ---- PATCH /v1/bookings/:id ----------------------------------------------------------------------------
    app.patch("/bookings/:id", async (req, res) => {
      const b = req.business!;
      const body = patchBody.parse(req.body ?? {});
      if (Object.values(body).every((v) => v === undefined)) {
        throw new ApiError("INVALID_INPUT", { fields: [{ path: "body", message: "send at least one field to change" }] });
      }

      const patch: BookingPatch = {
        customerName: body.customer_name,
        description: body.description,
        address: body.address,
        externalRef: body.external_ref,
      };
      if (body.customer_phone !== undefined) {
        const phone = normalizeJordanMobile(body.customer_phone);
        if (!phone) throw new ApiError("INVALID_PHONE");
        patch.customerPhone = phone;
      }
      try {
        const updated = await patchBooking(pool, { businessId: b.id, bookingId: idOf(req), patch, by: "api" });
        return reply(req, res, 200, bookingJson(updated, b.timezone), "تم تعديل بيانات الحجز ✅");
      } catch (err) {
        throw isDuplicateRef(err) ? duplicateRef() : err;
      }
    });

    // ---- POST /v1/bookings/:id/reschedule -------------------------------------------------------------------
    app.post("/bookings/:id/reschedule", (req, res) =>
      withIdempotency(pool, req, res, async () => {
        const b = req.business!;
        const body = rescheduleBody.parse(req.body ?? {});
        const token = readToken(b, body.slot_token);
        const current = await getBooking(pool, b.id, idOf(req));
        if (!current) throw new ApiError("NOT_FOUND");
        if (token.serviceId !== current.serviceId) {
          throw new ApiError("INVALID_INPUT", { fields: [{ path: "slot_token", message: "was issued for a different service" }] });
        }

        const moved = await placeSlot(
          b,
          token,
          (staffId) =>
            rescheduleBooking(pool, {
              businessId: b.id,
              bookingId: current.id,
              staffId,
              startsAt: new Date(token.startsAtMs),
              by: "api",
              enforceCutoffAt: opts.now(),
            }),
          current.id,
        );
        const local = DateTime.fromJSDate(moved.startsAt, { zone: b.timezone });
        return {
          status: 200,
          body: envelope(
            req,
            bookingJson(moved, b.timezone),
            `تم تغيير موعدك ✅ موعدك الجديد: ${fullDateAr(local.toISODate()!)} ${timePhraseAr(local.hour, local.minute)}.`,
          ),
        };
      }),
    );

    // ---- POST /v1/bookings/:id/cancel ----------------------------------------------------------------------
    app.post("/bookings/:id/cancel", (req, res) =>
      withIdempotency(pool, req, res, async () => {
        const b = req.business!;
        const body = cancelBody.parse(req.body ?? {});
        const { booking } = await cancelBooking(pool, {
          businessId: b.id,
          bookingId: idOf(req),
          reason: body.reason ?? null,
          by: "api",
          enforceCutoffAt: opts.now(),
        });
        return { status: 200, body: envelope(req, bookingJson(booking, b.timezone), "تم إلغاء موعدك ✅ إذا بدك تحجز موعد جديد احكيلنا.") };
      }),
    );

    // ---- POST /v1/bookings/:id/status ----------------------------------------------------------------------
    app.post("/bookings/:id/status", (req, res) =>
      withIdempotency(pool, req, res, async () => {
        const b = req.business!;
        const body = statusBody.parse(req.body ?? {});
        const booking = await setBookingStatus(pool, { businessId: b.id, bookingId: idOf(req), status: body.status, by: "api" });
        return { status: 200, body: envelope(req, bookingJson(booking, b.timezone), "تم تحديث حالة الحجز ✅") };
      }),
    );
  };
}
