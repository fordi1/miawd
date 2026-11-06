import type { FastifyInstance, FastifyRequest } from "fastify";
import { DateTime } from "luxon";
import type pg from "pg";
import { z } from "zod";
import { registerCatalogRoutes } from "../api/catalogRoutes.js";
import { isoDate, reply } from "../api/common.js";
import { ApiError } from "../api/errors.js";
import { findSlots } from "../availability/findSlots.js";
import { createBooking } from "../bookings/createBooking.js";
import {
  cancelBooking,
  getBooking,
  getHistory,
  listBookings,
  patchBooking,
  rescheduleBooking,
  setBookingStatus,
  type BookingPatch,
} from "../bookings/manage.js";
import { toRecord } from "../bookings/record.js";
import { bookingJson } from "../bookings/serialize.js";
import { getService, getZone, listDaysOff, listServices, listStaff, listZones } from "../catalog/catalog.js";
import { normalizeJordanMobile } from "../lib/phone.js";

const uuid = z.string().uuid();
const MAX_CALENDAR_DAYS = 62;
const MAX_SLOT_DAYS = 31;

const calendarQuery = z.object({ from: isoDate, to: isoDate });
const slotsQuery = z.object({ service_id: uuid, zone_id: uuid.optional(), date_from: isoDate, date_to: isoDate, booking_id: uuid.optional() });
const listQuery = z.object({
  phone: z.string().trim().min(1).optional(),
  external_ref: z.string().trim().min(1).optional(),
  status: z.enum(["confirmed", "completed", "cancelled", "no_show"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const createBody = z
  .object({
    service_id: uuid,
    zone_id: uuid.nullable().optional(),
    staff_id: uuid,
    start_at: z.string().trim().min(1),
    customer_name: z.string().trim().min(1).max(100),
    customer_phone: z.string().trim().min(1).max(40),
    description: z.string().trim().max(500).optional(),
    address: z.string().trim().max(300).optional(),
    external_ref: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const patchBody = z
  .object({
    customer_name: z.string().trim().min(1).max(100).optional(),
    customer_phone: z.string().trim().min(1).max(40).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
    external_ref: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();
const rescheduleBody = z.object({ staff_id: uuid, start_at: z.string().trim().min(1) }).strict();
const cancelBody = z.object({ reason: z.string().trim().max(300).optional() });
const statusBody = z.object({ status: z.enum(["completed", "no_show"]) }).strict();

const invalid = (path: string, message: string) => new ApiError("INVALID_INPUT", { fields: [{ path, message }] });
const isDuplicateRef = (e: unknown) => (e as { code?: string }).code === "23505";

function instant(text: string, field: string): Date {
  const dt = DateTime.fromISO(text, { setZone: true });
  if (!dt.isValid) throw invalid(field, "must be an ISO 8601 date-time");
  return dt.toJSDate();
}
function phoneOf(text: string): string {
  const phone = normalizeJordanMobile(text);
  if (!phone) throw new ApiError("INVALID_PHONE");
  return phone;
}

/**
 * Everything the Business Panel needs besides the setup routes it shares with the API (staff, services, zones,
 * days off, settings): the calendar, the free times for a manual booking, and the booking actions. Changes made here are
 * recorded as made by the business — or by the admin when the platform admin opened this panel — and are not limited by
 * the "2 hours before" rule the API has.
 */
export function registerAppPanelRoutes(app: FastifyInstance, pool: pg.Pool, opts: { now: () => Date; webhookAllowLocal: boolean }) {
  registerCatalogRoutes(app, pool, { now: opts.now, webhookAllowLocal: opts.webhookAllowLocal, webhookEditable: false });

  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const actorOf = (req: FastifyRequest) => req.panel!.actor;
  const staffBelongs = async (businessId: string, staffId: string) =>
    ((await pool.query("SELECT 1 FROM staff WHERE id = $1 AND business_id = $2", [staffId, businessId])).rowCount ?? 0) > 0;

  // ---- calendar --------------------------------------------------------------------------------------------------
  app.get("/calendar", async (req, res) => {
    const b = req.business!;
    const q = calendarQuery.parse(req.query);
    const from = DateTime.fromISO(q.from, { zone: b.timezone });
    const toExclusive = DateTime.fromISO(q.to, { zone: b.timezone }).plus({ days: 1 });
    const days = toExclusive.diff(from, "days").days;
    if (days < 1) throw invalid("to", "must be on or after from");
    if (days > MAX_CALENDAR_DAYS) throw invalid("to", `at most ${MAX_CALENDAR_DAYS} days at a time`);

    const { rows } = await pool.query(
      `SELECT bk.*, s.name_ar AS service_name_ar, s.name_en AS service_name_en, z.name_ar AS zone_name_ar, st.name_ar AS staff_name_ar
         FROM bookings bk
         JOIN services s ON s.id = bk.service_id
         JOIN staff st ON st.id = bk.staff_id
         LEFT JOIN zones z ON z.id = bk.zone_id
        WHERE bk.business_id = $1 AND bk.starts_at >= $2 AND bk.starts_at < $3
        ORDER BY bk.starts_at, bk.id`,
      [b.id, from.toJSDate(), toExclusive.toJSDate()],
    );
    const daysOff = await listDaysOff(pool, b.id, { endingAfter: from.toJSDate(), startingBefore: toExclusive.toJSDate() });

    return reply(req, res, 200, {
      timezone: b.timezone,
      from: q.from,
      to: q.to,
      staff: await listStaff(pool, b.id, false),
      services: await listServices(pool, b.id, false),
      zones: await listZones(pool, b.id, false),
      bookings: rows.map((r) => ({
        ...bookingJson(toRecord(r), b.timezone),
        service_name_ar: r.service_name_ar,
        service_name_en: r.service_name_en,
        zone_name_ar: r.zone_name_ar,
        staff_name_ar: r.staff_name_ar,
      })),
      days_off: daysOff.map((d) => ({ id: d.id, staff_id: d.staff_id, start_at: d.start_at.toISOString(), end_at: d.end_at.toISOString(), reason: d.reason })),
    }, null);
  });

  // ---- free times for a manual booking ---------------------------------------------------------------------------
  app.get("/slots", async (req, res) => {
    const b = req.business!;
    const q = slotsQuery.parse(req.query);
    const service = await getService(pool, b.id, q.service_id);
    if (!service?.active) throw new ApiError("SERVICE_NOT_FOUND");
    if (q.zone_id && !(await getZone(pool, b.id, q.zone_id))) throw invalid("zone_id", "no such zone in this business");

    const span = DateTime.fromISO(q.date_to).diff(DateTime.fromISO(q.date_from), "days").days;
    if (span < 0 || span >= MAX_SLOT_DAYS) throw invalid("date_to", `must be on or after date_from, within ${MAX_SLOT_DAYS} days`);

    const names = new Map((await listStaff(pool, b.id, true)).map((s) => [s.id, s]));
    const slots = await findSlots(pool, {
      businessId: b.id, serviceId: service.id, zoneId: q.zone_id, fromDate: q.date_from, toDate: q.date_to,
      ignoreBookingId: q.booking_id, now: opts.now(),
    });
    return reply(req, res, 200, {
      slots: slots.map((s) => ({
        start_at: s.startsAt.toISOString(),
        end_at: s.endsAt.toISOString(),
        local_date: s.localDate,
        local_time: s.localTime,
        part_of_day: s.partOfDay,
        staff_id: s.staffId,
        staff_name_ar: names.get(s.staffId)?.name_ar ?? null,
        staff_name_en: names.get(s.staffId)?.name_en ?? null,
      })),
    }, null);
  });

  // ---- bookings --------------------------------------------------------------------------------------------------
  app.get("/bookings", async (req, res) => {
    const b = req.business!;
    const q = listQuery.parse(req.query);
    const day = (date: string) => DateTime.fromISO(date, { zone: b.timezone });
    const found = await listBookings(pool, b.id, {
      phone: q.phone ? phoneOf(q.phone) : undefined,
      externalRef: q.external_ref,
      status: q.status,
      from: q.from ? day(q.from).toJSDate() : undefined,
      to: q.to ? day(q.to).plus({ days: 1 }).toJSDate() : undefined,
      limit: q.limit,
    });
    return reply(req, res, 200, { bookings: found.map((r) => bookingJson(r, b.timezone)) }, null);
  });

  app.post("/bookings", async (req, res) => {
    const b = req.business!;
    const body = createBody.parse(req.body ?? {});
    const startsAt = instant(body.start_at, "start_at");
    const phone = phoneOf(body.customer_phone);
    if (body.zone_id && !(await getZone(pool, b.id, body.zone_id))) throw invalid("zone_id", "no such zone in this business");

    try {
      const made = await createBooking(pool, {
        businessId: b.id, serviceId: body.service_id, staffId: body.staff_id, zoneId: body.zone_id ?? null, startsAt,
        customerName: body.customer_name, customerPhone: phone, address: body.address ?? null, description: body.description ?? null,
        externalRef: body.external_ref ?? null, source: "panel", actor: actorOf(req),
      });
      return reply(req, res, 201, bookingJson((await getBooking(pool, b.id, made.id))!, b.timezone), null);
    } catch (err) {
      throw isDuplicateRef(err) ? invalid("external_ref", "already used by another booking") : err;
    }
  });

  app.get("/bookings/:id", async (req, res) => {
    const b = req.business!;
    const booking = await getBooking(pool, b.id, idOf(req));
    if (!booking) throw new ApiError("NOT_FOUND");
    const history = await getHistory(pool, booking.id);
    return reply(req, res, 200, {
      ...bookingJson(booking, b.timezone),
      history: history.map((h) => ({ action: h.action, by: h.by, at: h.at.toISOString(), data: h.data })),
    }, null);
  });

  app.patch("/bookings/:id", async (req, res) => {
    const b = req.business!;
    const body = patchBody.parse(req.body ?? {});
    if (Object.values(body).every((v) => v === undefined)) throw invalid("body", "send at least one field to change");
    const patch: BookingPatch = {
      customerName: body.customer_name,
      customerPhone: body.customer_phone === undefined ? undefined : phoneOf(body.customer_phone),
      description: body.description,
      address: body.address,
      externalRef: body.external_ref,
    };
    try {
      return reply(req, res, 200, bookingJson(await patchBooking(pool, { businessId: b.id, bookingId: idOf(req), patch, by: actorOf(req) }), b.timezone), null);
    } catch (err) {
      throw isDuplicateRef(err) ? invalid("external_ref", "already used by another booking") : err;
    }
  });

  app.post("/bookings/:id/reschedule", async (req, res) => {
    const b = req.business!;
    const body = rescheduleBody.parse(req.body ?? {});
    const startsAt = instant(body.start_at, "start_at");
    if (!(await staffBelongs(b.id, body.staff_id))) throw invalid("staff_id", "no such staff member in this business");
    const moved = await rescheduleBooking(pool, { businessId: b.id, bookingId: idOf(req), staffId: body.staff_id, startsAt, by: actorOf(req) });
    return reply(req, res, 200, bookingJson(moved, b.timezone), null);
  });

  app.post("/bookings/:id/cancel", async (req, res) => {
    const b = req.business!;
    const body = cancelBody.parse(req.body ?? {});
    const { booking } = await cancelBooking(pool, { businessId: b.id, bookingId: idOf(req), reason: body.reason ?? null, by: actorOf(req) });
    return reply(req, res, 200, bookingJson(booking, b.timezone), null);
  });

  app.post("/bookings/:id/status", async (req, res) => {
    const b = req.business!;
    const body = statusBody.parse(req.body ?? {});
    const booking = await setBookingStatus(pool, { businessId: b.id, bookingId: idOf(req), status: body.status, by: actorOf(req) });
    return reply(req, res, 200, bookingJson(booking, b.timezone), null);
  });
}
