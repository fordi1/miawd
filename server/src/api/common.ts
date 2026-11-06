import type { FastifyReply, FastifyRequest } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import type { AuthedBusiness } from "../auth/apiKey.js";
import { applyDigits, type DigitStyle } from "../i18n/arabic.js";

export const digitStyle = (b: AuthedBusiness | undefined): DigitStyle => (b?.settings.display_digits === "arabic" ? "arabic" : "latin");

/**
 * The standard success envelope. `displayAr` is the ready-to-send customer text, or null for setup endpoints
 * (staff, services…) whose answers are for developers, not for customers.
 */
export function envelope(req: FastifyRequest, data: unknown, displayAr: string | null) {
  return {
    ok: true,
    data,
    display_ar: displayAr === null ? null : applyDigits(displayAr, digitStyle(req.business)),
    request_id: req.id,
  };
}

export const reply = (req: FastifyRequest, res: FastifyReply, status: number, data: unknown, displayAr: string | null) =>
  res.status(status).send(envelope(req, data, displayAr));

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use yyyy-MM-dd")
  .refine((s) => DateTime.fromISO(s).isValid, "not a real date");
