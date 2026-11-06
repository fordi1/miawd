import type { FastifyInstance, FastifyRequest } from "fastify";
import { DateTime } from "luxon";
import type pg from "pg";
import { z } from "zod";
import {
  createDayOff,
  createService,
  createStaff,
  createZone,
  deleteDayOff,
  getBusinessInfo,
  getService,
  getStaff,
  getZone,
  listDaysOff,
  listServices,
  listStaff,
  listZones,
  patchSettings,
  setStaffHours,
  setWebhookUrl,
  updateService,
  updateStaff,
  updateZone,
  type DayOffRecord,
  type ServicePatch,
  type StaffPatch,
  type ZonePatch,
} from "../catalog/catalog.js";
import { normalizeJordanMobile } from "../lib/phone.js";
import { validateWebhookUrl } from "../webhooks/url.js";
import { envelope, isoDate, reply } from "./common.js";
import { ApiError } from "./errors.js";
import { withIdempotency } from "./idempotency.js";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:mm");
const interval = z.object({ weekday: z.number().int().min(0).max(6), start: hhmm, end: hhmm }).strict();
const name = z.string().trim().min(1).max(100);
const optionalName = z.string().trim().max(100).nullable().optional();
const aliases = z.array(z.string().trim().min(1).max(100)).max(30);
const ids = z.array(z.string().uuid()).max(200);
const phone = z.string().trim().min(1).max(40).nullable().optional();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "use #RRGGBB");
const fee = z.coerce.number().min(0).max(10000).nullable().optional();

const staffCreate = z
  .object({
    name_ar: name, name_en: optionalName, phone, color: color.optional(),
    service_ids: ids.optional(), zone_ids: ids.optional(), hours: z.array(interval).max(70).optional(),
  })
  .strict();
const staffPatch = z
  .object({
    name_ar: name.optional(), name_en: optionalName, phone, color: color.optional(),
    service_ids: ids.optional(), zone_ids: ids.optional(), active: z.boolean().optional(),
  })
  .strict();
const hoursBody = z.object({ hours: z.array(interval).max(70) }).strict();

const serviceCreate = z
  .object({ name_ar: name, name_en: optionalName, aliases: aliases.optional(), duration_min: z.number().int().min(5).max(720) })
  .strict();
const servicePatch = z
  .object({
    name_ar: name.optional(), name_en: optionalName, aliases: aliases.optional(),
    duration_min: z.number().int().min(5).max(720).optional(), active: z.boolean().optional(),
  })
  .strict();

const zoneCreate = z.object({ name_ar: name, name_en: optionalName, aliases: aliases.optional(), visit_fee_jod: fee }).strict();
const zonePatch = z
  .object({ name_ar: name.optional(), name_en: optionalName, aliases: aliases.optional(), visit_fee_jod: fee, active: z.boolean().optional() })
  .strict();

const dayOffBody = z
  .object({
    staff_id: z.string().uuid().optional(),
    reason: z.string().trim().max(200).optional(),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
    start_at: z.string().trim().min(1).optional(),
    end_at: z.string().trim().min(1).optional(),
  })
  .strict();
const dayOffQuery = z.object({ staff_id: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional() });

const settingsSchema = z
  .object({
    slot_step_min: z.number().int().min(5).max(120).optional(),
    gap_min: z.number().int().min(0).max(240).optional(),
    min_lead_min: z.number().int().min(0).max(10080).optional(),
    horizon_days: z.number().int().min(1).max(365).optional(),
    change_cutoff_min: z.number().int().min(0).max(10080).optional(),
    display_digits: z.enum(["latin", "arabic"]).optional(),
  })
  .strict();
const businessPatch = z.object({ settings: settingsSchema.optional(), webhook_url: z.string().trim().min(1).nullable().optional() }).strict();

const listQuery = z.object({ include_inactive: z.enum(["true", "false"]).optional() });

const invalid = (path: string, message: string) => new ApiError("INVALID_INPUT", { fields: [{ path, message }] });
const nothingToChange = (body: object) => {
  if (Object.values(body).every((v) => v === undefined)) throw invalid("body", "send at least one field to change");
};
/** undefined / null stay as they are (leave alone / clear); text must be a Jordanian mobile number. */
const phoneOf = (text: string | null | undefined) => {
  if (text === undefined || text === null) return text;
  const normalized = normalizeJordanMobile(text);
  if (!normalized) throw new ApiError("INVALID_PHONE");
  return normalized;
};

const dayOffJson = (d: DayOffRecord) => ({
  id: d.id,
  staff_id: d.staff_id,
  start_at: d.start_at.toISOString(),
  end_at: d.end_at.toISOString(),
  reason: d.reason,
});

/** Staff, services, zones, days off and settings: everything a business needs to be configured through the API. */
export function registerCatalogRoutes(app: FastifyInstance, pool: pg.Pool, opts: { now: () => Date; webhookAllowLocal: boolean; webhookEditable: boolean }) {
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const includeInactive = (req: FastifyRequest) => listQuery.parse(req.query).include_inactive === "true";

  // ---- business ------------------------------------------------------------------------------------------------
  /** The business as shown; where the webhook cannot be edited it is not shown either. */
  const businessView = async (id: string) => {
    const info = await getBusinessInfo(pool, id);
    if (opts.webhookEditable) return info;
    const { webhook_url: _url, webhook_secret: _secret, ...rest } = info;
    return rest;
  };
  app.get("/business", async (req, res) => reply(req, res, 200, await businessView(req.business!.id), null));

  app.patch("/business", async (req, res) => {
    const id = req.business!.id;
    const body = businessPatch.parse(req.body ?? {});
    if (body.webhook_url !== undefined && !opts.webhookEditable) {
      throw new ApiError("FORBIDDEN", { message: "The webhook is set through the API or by the platform admin." });
    }
    const settings = Object.fromEntries(Object.entries(body.settings ?? {}).filter(([, v]) => v !== undefined)) as Record<string, number | string>;
    if (Object.keys(settings).length === 0 && body.webhook_url === undefined) {
      throw invalid("body", "send settings and/or webhook_url");
    }

    let webhookUrl: string | null | undefined;
    if (body.webhook_url !== undefined) {
      try {
        webhookUrl = body.webhook_url === null ? null : validateWebhookUrl(body.webhook_url, opts.webhookAllowLocal);
      } catch (err) {
        throw invalid("webhook_url", (err as Error).message);
      }
    }
    if (Object.keys(settings).length > 0) await patchSettings(pool, id, settings);
    if (webhookUrl !== undefined) await setWebhookUrl(pool, id, webhookUrl);
    return reply(req, res, 200, await businessView(id), null);
  });

  // ---- staff ---------------------------------------------------------------------------------------------------
  app.get("/staff", async (req, res) =>
    reply(req, res, 200, { staff: await listStaff(pool, req.business!.id, includeInactive(req)) }, null));

  app.get("/staff/:id", async (req, res) => {
    const staff = await getStaff(pool, req.business!.id, idOf(req));
    if (!staff) throw new ApiError("NOT_FOUND");
    return reply(req, res, 200, staff, null);
  });

  app.post("/staff", (req, res) =>
    withIdempotency(pool, req, res, async () => {
      const body = staffCreate.parse(req.body);
      const created = await createStaff(pool, req.business!.id, { ...body, phone: phoneOf(body.phone) });
      return { status: 201, body: envelope(req, created, null) };
    }));

  app.patch("/staff/:id", async (req, res) => {
    const body = staffPatch.parse(req.body ?? {});
    nothingToChange(body);
    const patch: StaffPatch = { ...body, phone: phoneOf(body.phone) };
    return reply(req, res, 200, await updateStaff(pool, req.business!.id, idOf(req), patch, opts.now()), null);
  });

  // Deleting only switches the staff member off: past bookings keep pointing at them.
  app.delete("/staff/:id", async (req, res) =>
    reply(req, res, 200, await updateStaff(pool, req.business!.id, idOf(req), { active: false }, opts.now()), null));

  app.put("/staff/:id/hours", async (req, res) => {
    const body = hoursBody.parse(req.body ?? {});
    return reply(req, res, 200, await setStaffHours(pool, req.business!.id, idOf(req), body.hours), null);
  });

  // ---- services ------------------------------------------------------------------------------------------------
  app.get("/services", async (req, res) =>
    reply(req, res, 200, { services: await listServices(pool, req.business!.id, includeInactive(req)) }, null));

  app.get("/services/:id", async (req, res) => {
    const service = await getService(pool, req.business!.id, idOf(req));
    if (!service) throw new ApiError("NOT_FOUND");
    return reply(req, res, 200, service, null);
  });

  app.post("/services", (req, res) =>
    withIdempotency(pool, req, res, async () => {
      const created = await createService(pool, req.business!.id, serviceCreate.parse(req.body));
      return { status: 201, body: envelope(req, created, null) };
    }));

  app.patch("/services/:id", async (req, res) => {
    const body = servicePatch.parse(req.body ?? {});
    nothingToChange(body);
    return reply(req, res, 200, await updateService(pool, req.business!.id, idOf(req), body as ServicePatch, opts.now()), null);
  });

  app.delete("/services/:id", async (req, res) =>
    reply(req, res, 200, await updateService(pool, req.business!.id, idOf(req), { active: false }, opts.now()), null));

  // ---- zones ---------------------------------------------------------------------------------------------------
  app.get("/zones", async (req, res) =>
    reply(req, res, 200, { zones: await listZones(pool, req.business!.id, includeInactive(req)) }, null));

  app.get("/zones/:id", async (req, res) => {
    const zone = await getZone(pool, req.business!.id, idOf(req));
    if (!zone) throw new ApiError("NOT_FOUND");
    return reply(req, res, 200, zone, null);
  });

  app.post("/zones", (req, res) =>
    withIdempotency(pool, req, res, async () => {
      const created = await createZone(pool, req.business!.id, zoneCreate.parse(req.body));
      return { status: 201, body: envelope(req, created, null) };
    }));

  app.patch("/zones/:id", async (req, res) => {
    const body = zonePatch.parse(req.body ?? {});
    nothingToChange(body);
    return reply(req, res, 200, await updateZone(pool, req.business!.id, idOf(req), body as ZonePatch, opts.now()), null);
  });

  app.delete("/zones/:id", async (req, res) =>
    reply(req, res, 200, await updateZone(pool, req.business!.id, idOf(req), { active: false }, opts.now()), null));

  // ---- days off ------------------------------------------------------------------------------------------------
  app.get("/days-off", async (req, res) => {
    const b = req.business!;
    const q = dayOffQuery.parse(req.query);
    const day = (date: string) => DateTime.fromISO(date, { zone: b.timezone });
    const found = await listDaysOff(pool, b.id, {
      staffId: q.staff_id,
      endingAfter: q.from ? day(q.from).toJSDate() : DateTime.fromJSDate(opts.now(), { zone: b.timezone }).startOf("day").toJSDate(),
      startingBefore: q.to ? day(q.to).plus({ days: 1 }).toJSDate() : undefined,
    });
    return reply(req, res, 200, { days_off: found.map(dayOffJson) }, null);
  });

  app.post("/days-off", (req, res) =>
    withIdempotency(pool, req, res, async () => {
      const b = req.business!;
      const body = dayOffBody.parse(req.body);

      const hasDates = body.date_from !== undefined || body.date_to !== undefined;
      const hasInstants = body.start_at !== undefined || body.end_at !== undefined;
      if (hasDates === hasInstants) throw invalid("body", "send either date_from + date_to, or start_at + end_at");

      let startsAt: Date;
      let endsAt: Date;
      if (hasDates) {
        if (!body.date_from || !body.date_to) throw invalid("date_to", "send both date_from and date_to");
        const from = DateTime.fromISO(body.date_from, { zone: b.timezone });
        const to = DateTime.fromISO(body.date_to, { zone: b.timezone }).plus({ days: 1 }); // date_to is inclusive
        if (to <= from) throw invalid("date_to", "must be on or after date_from");
        if (to.diff(from, "days").days > 366) throw invalid("date_to", "at most one year at a time");
        startsAt = from.toJSDate();
        endsAt = to.toJSDate();
      } else {
        const start = body.start_at ? DateTime.fromISO(body.start_at, { setZone: true }) : null;
        const end = body.end_at ? DateTime.fromISO(body.end_at, { setZone: true }) : null;
        if (!start?.isValid) throw invalid("start_at", "must be an ISO 8601 date-time");
        if (!end?.isValid) throw invalid("end_at", "must be an ISO 8601 date-time");
        startsAt = start.toJSDate();
        endsAt = end.toJSDate();
      }

      const created = await createDayOff(pool, b.id, { staffId: body.staff_id, startsAt, endsAt, reason: body.reason });
      return { status: 201, body: envelope(req, dayOffJson(created), null) };
    }));

  app.delete("/days-off/:id", async (req, res) => {
    await deleteDayOff(pool, req.business!.id, idOf(req));
    return reply(req, res, 200, { id: idOf(req), deleted: true }, null);
  });
}
