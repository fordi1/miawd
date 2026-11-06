import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type pg from "pg";
import { ZodError } from "zod";
import { BookingError } from "./bookings/createBooking.js";
import { CatalogError } from "./catalog/catalog.js";
import { ApiError, ERRORS, type ErrorCode } from "./api/errors.js";
import { DEFAULT_RATE_LIMIT, TokenBuckets, type RateLimitOptions } from "./api/rateLimit.js";
import { v1Routes } from "./api/v1.js";
import { docsRoutes } from "./docs/docsRoutes.js";
import { addSecurityHeaders, registerPanels } from "./web/panels.js";
import { panelRoutes } from "./panel/panelRoutes.js";
import { applyDigits } from "./i18n/arabic.js";

export interface AppOptions {
  apiKeyPepper: string;
  slotTokenSecret: string;
  /** Injectable clock (tests); defaults to the real time. */
  now?: () => Date;
  logger?: boolean;
  /** Tests and local development only: webhook URLs may be http and point to this machine. */
  webhookAllowLocal?: boolean;
  /** Requests per business: defaults to 20 per second with a burst of 40. */
  rateLimit?: Partial<RateLimitOptions>;
  /** Panel login attempts: defaults to 5 per minute per IP address and 10 per hour per username. */
  loginRateLimit?: Partial<RateLimitOptions>;
  /** Add `Secure` to the panel cookies (set when the server is reached over https). */
  cookieSecure?: boolean;
  /** Trust X-Forwarded-For (only when the server runs behind our own reverse proxy). */
  trustProxy?: boolean;
  /** The address people reach this server at, e.g. https://api.example.com (shown in the docs). Default: taken from each request. */
  publicUrl?: string;
  /** Where the built panels are (default: ../public next to the compiled code). Missing = not served (development). */
  publicDir?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    /** "METHOD /full/path" of every route (used by a test that compares them with the documentation). */
    registeredRoutes: string[];
  }
}

export async function buildApp(pool: pg.Pool, opts: AppOptions) {
  const now = opts.now ?? (() => new Date());
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: opts.trustProxy ?? false,
    genReqId: () => `req_${randomBytes(8).toString("hex")}`,
  });

  addSecurityHeaders(app);
  const registeredRoutes: string[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) if (method !== "HEAD") registeredRoutes.push(`${method} ${route.url}`);
  });
  app.decorate("registeredRoutes", registeredRoutes);

  app.addHook("onRequest", async (req, res) => {
    res.header("x-request-id", req.id);
  });

  app.setErrorHandler((err, req, res) => {
    let apiErr: ApiError;
    if (err instanceof ApiError) {
      apiErr = err;
    } else if (err instanceof ZodError) {
      apiErr = new ApiError("INVALID_INPUT", {
        fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    } else if (err instanceof BookingError) {
      apiErr = new ApiError(err.code as ErrorCode);
    } else if (err instanceof CatalogError) {
      apiErr = new ApiError(err.code, { message: err.message, fields: err.fields });
    } else if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) {
      apiErr = new ApiError("INVALID_INPUT", { message: (err as Error).message }); // e.g. malformed JSON
    } else {
      req.log.error(err);
      apiErr = new ApiError("SERVER_ERROR");
    }

    const def = ERRORS[apiErr.code];
    const text = apiErr.details.displayAr ?? def.displayAr;
    const style = req.business?.settings.display_digits === "arabic" ? "arabic" : "latin";
    return res.status(def.status).send({
      ok: false,
      error: {
        code: apiErr.code,
        message: apiErr.message,
        display_ar: text === null ? null : applyDigits(text, style),
        ...(apiErr.details.fields && { fields: apiErr.details.fields }),
        ...(apiErr.details.alternatives && { alternatives: apiErr.details.alternatives }),
      },
      request_id: req.id,
    });
  });

  app.setNotFoundHandler((req, res) =>
    res.status(404).send({
      ok: false,
      error: { code: "NOT_FOUND", message: "No such endpoint.", display_ar: null },
      request_id: req.id,
    }),
  );

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  await app.register(docsRoutes({ publicUrl: opts.publicUrl }));
  await registerPanels(app, opts.publicDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public"));
  const limiter = new TokenBuckets({ ...DEFAULT_RATE_LIMIT, ...opts.rateLimit });
  await app.register(v1Routes(pool, { apiKeyPepper: opts.apiKeyPepper, slotTokenSecret: opts.slotTokenSecret, now, webhookAllowLocal: opts.webhookAllowLocal ?? false, limiter }), {
    prefix: "/v1",
  });
  await app.register(
    panelRoutes(pool, {
      apiKeyPepper: opts.apiKeyPepper,
      now,
      webhookAllowLocal: opts.webhookAllowLocal ?? false,
      cookieSecure: opts.cookieSecure ?? false,
      loginByIp: new TokenBuckets({ perSecond: 5 / 60, burst: 5, ...opts.loginRateLimit }),
      loginByUser: new TokenBuckets({ perSecond: 10 / 3600, burst: 10, ...opts.loginRateLimit }),
    }),
    { prefix: "/panel" },
  );
  return app;
}
