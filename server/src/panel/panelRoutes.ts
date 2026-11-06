import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DateTime } from "luxon";
import type pg from "pg";
import { z } from "zod";
import { reply } from "../api/common.js";
import { ApiError } from "../api/errors.js";
import type { TokenBuckets } from "../api/rateLimit.js";
import { issueApiKey } from "../auth/apiKey.js";
import { hashPassword, verifyAgainstNobody, verifyPassword } from "../auth/passwords.js";
import { getBusinessInfo, setWebhookUrl } from "../catalog/catalog.js";
import { validateWebhookUrl } from "../webhooks/url.js";
import {
  PLATFORM_TIMEZONE,
  createBusiness,
  deleteBusiness,
  getBusinessSummary,
  listBusinesses,
  monthRange,
  resetOwnerPassword,
  resetTestData,
  updateBusiness,
  type MonthCounts,
} from "./adminService.js";
import {
  ADMIN_COOKIE,
  APP_COOKIE,
  clearedCookie,
  createSession,
  deleteBusinessSessions,
  deleteSession,
  parseCookies,
  readSession,
  sessionCookie,
} from "./sessions.js";
import { registerAppPanelRoutes } from "./appRoutes.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Reachable without a session (login). */
    public?: boolean;
  }
  interface FastifyRequest {
    admin?: { id: string; username: string };
    /** The Business Panel session: who is acting, and whether the platform admin opened it. */
    panel?: {
      tokenHash: string;
      byAdmin: boolean;
      actor: "business" | "admin";
      username: string;
      mustChangePassword: boolean;
      staffLabelAr: string;
      staffLabelEn: string;
    };
    sessionHash?: string;
  }
}

export interface PanelOptions {
  apiKeyPepper: string;
  now: () => Date;
  webhookAllowLocal: boolean;
  cookieSecure: boolean;
  loginByIp: TokenBuckets;
  loginByUser: TokenBuckets;
}

const loginBody = z.object({ username: z.string().trim().toLowerCase().min(1).max(100), password: z.string().min(1).max(200) });
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,49}$/, "3–50 characters: a-z, 0-9, dot, dash or underscore");
const passwordSchema = z.string().min(8, "at least 8 characters").max(200);
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "use yyyy-MM");

const createBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    username: usernameSchema,
    password: passwordSchema,
    goes_to_customer: z.boolean().default(false),
    staff_label_ar: z.string().trim().min(1).max(50).default("موظف"),
    staff_label_en: z.string().trim().min(1).max(50).default("Staff"),
    is_test: z.boolean().default(false),
  })
  .strict();
const patchBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    username: usernameSchema.optional(),
    goes_to_customer: z.boolean().optional(),
    staff_label_ar: z.string().trim().min(1).max(50).optional(),
    staff_label_en: z.string().trim().min(1).max(50).optional(),
    active: z.boolean().optional(),
    webhook_url: z.string().trim().min(1).nullable().optional(),
  })
  .strict();
const resetPasswordBody = z.object({ password: passwordSchema }).strict();
const deleteBody = z.object({ confirm_name: z.string() }).strict();

const invalid = (path: string, message: string) => new ApiError("INVALID_INPUT", { fields: [{ path, message }] });
const sumCounts = (rows: MonthCounts[]): MonthCounts =>
  rows.reduce((t, r) => ({
    total: t.total + r.total, confirmed: t.confirmed + r.confirmed, cancelled: t.cancelled + r.cancelled,
    completed: t.completed + r.completed, no_show: t.no_show + r.no_show,
  }), { total: 0, confirmed: 0, cancelled: 0, completed: 0, no_show: 0 });

export function panelRoutes(pool: pg.Pool, opts: PanelOptions) {
  return async function plugin(app: FastifyInstance) {
    // A request that changes something must come from our own pages (or from no browser at all), never from another website.
    app.addHook("onRequest", async (req) => {
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
      const origin = req.headers.origin;
      if (origin === undefined) return;
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {
        /* "null" or garbage: refuse below */
      }
      if (host !== req.headers.host) throw new ApiError("FORBIDDEN");
    });

    /** Counts a login attempt against the IP and the username; throws 429 when either has used up its attempts. */
    function throttleLogin(req: FastifyRequest, res: FastifyReply, username: string) {
      for (const taken of [opts.loginByIp.take(`ip:${req.ip}`), opts.loginByUser.take(`user:${username}`)]) {
        if (!taken.allowed) {
          res.header("retry-after", String(taken.retryAfterSec));
          throw new ApiError("RATE_LIMITED");
        }
      }
    }

    await app.register(adminPlugin, { prefix: "/admin" });
    await app.register(appPlugin, { prefix: "/app" });

    // ================================================================================================================
    // Admin Panel
    // ================================================================================================================
    async function adminPlugin(admin: FastifyInstance) {
      admin.addHook("onRequest", async (req) => {
        if (req.routeOptions.config.public) return;
        const session = await readSession(pool, parseCookies(req.headers.cookie)[ADMIN_COOKIE], "admin");
        const { rows: [a] } = session ? await pool.query("SELECT id, username FROM admins WHERE id = $1", [session.adminId]) : { rows: [] };
        if (!a) throw new ApiError("UNAUTHORIZED");
        req.admin = a;
        req.sessionHash = session!.tokenHash;
      });

      admin.post("/login", { config: { public: true } }, async (req, res) => {
        const body = loginBody.parse(req.body ?? {});
        throttleLogin(req, res, body.username);
        const { rows: [a] } = await pool.query("SELECT id, username, password_hash FROM admins WHERE username = $1", [body.username]);
        const ok = a ? await verifyPassword(body.password, a.password_hash) : await verifyAgainstNobody(body.password);
        if (!a || !ok) throw new ApiError("INVALID_CREDENTIALS");
        const token = await createSession(pool, { kind: "admin", adminId: a.id });
        res.header("set-cookie", sessionCookie(ADMIN_COOKIE, token, opts.cookieSecure));
        return reply(req, res, 200, { username: a.username }, null);
      });

      admin.post("/logout", async (req, res) => {
        await deleteSession(pool, req.sessionHash!);
        res.header("set-cookie", clearedCookie(ADMIN_COOKIE, opts.cookieSecure));
        return reply(req, res, 200, { logged_out: true }, null);
      });

      admin.get("/me", async (req, res) => reply(req, res, 200, { username: req.admin!.username }, null));

      const currentMonth = () => DateTime.fromJSDate(opts.now(), { zone: PLATFORM_TIMEZONE }).toFormat("yyyy-MM");
      const monthOf = (req: FastifyRequest) => {
        const parsed = z.object({ month: monthSchema.optional() }).parse(req.query);
        return parsed.month ?? currentMonth();
      };

      admin.get("/dashboard", async (req, res) => {
        const month = monthOf(req);
        const rows = await listBusinesses(pool, monthRange(month), { includeTest: false });
        return reply(req, res, 200, {
          month,
          businesses_total: rows.length,
          businesses_active: rows.filter((r) => r.active).length,
          totals: sumCounts(rows),
          businesses: rows.map((r) => ({
            id: r.id, name: r.name, active: r.active, total: r.total, confirmed: r.confirmed,
            cancelled: r.cancelled, completed: r.completed, no_show: r.no_show,
          })),
        }, null);
      });

      admin.get("/businesses", async (req, res) => {
        const month = monthOf(req);
        return reply(req, res, 200, { month, businesses: await listBusinesses(pool, monthRange(month), { includeTest: true }) }, null);
      });

      const summaryOf = async (id: string) => {
        const found = await getBusinessSummary(pool, id, monthRange(currentMonth()));
        if (!found) throw new ApiError("NOT_FOUND");
        return found;
      };
      const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

      admin.get("/businesses/:id", async (req, res) => reply(req, res, 200, await summaryOf(idOf(req)), null));

      admin.post("/businesses", async (req, res) => {
        const id = await createBusiness(pool, createBody.parse(req.body ?? {}));
        const apiKey = await issueApiKey(pool, id, opts.apiKeyPepper); // shown once, here
        return reply(req, res, 201, { business: await summaryOf(id), api_key: apiKey }, null);
      });

      admin.patch("/businesses/:id", async (req, res) => {
        const id = idOf(req);
        await summaryOf(id);
        const { webhook_url, ...fields } = patchBody.parse(req.body ?? {});
        if (webhook_url === undefined && Object.values(fields).every((v) => v === undefined)) throw invalid("body", "send at least one field to change");

        let webhookUrl: string | null | undefined;
        if (webhook_url !== undefined) {
          try {
            webhookUrl = webhook_url === null ? null : validateWebhookUrl(webhook_url, opts.webhookAllowLocal);
          } catch (err) {
            throw invalid("webhook_url", (err as Error).message);
          }
        }
        await updateBusiness(pool, id, fields);
        if (webhookUrl !== undefined) await setWebhookUrl(pool, id, webhookUrl);
        if (fields.active === false) await deleteBusinessSessions(pool, id); // switched off: the owner is logged out
        return reply(req, res, 200, await summaryOf(id), null);
      });

      admin.post("/businesses/:id/api-key", async (req, res) => {
        const id = idOf(req);
        await summaryOf(id);
        const apiKey = await issueApiKey(pool, id, opts.apiKeyPepper);
        return reply(req, res, 200, { api_key: apiKey, api_key_last4: apiKey.slice(-4) }, null);
      });

      admin.post("/businesses/:id/password", async (req, res) => {
        const id = idOf(req);
        await summaryOf(id);
        await resetOwnerPassword(pool, id, resetPasswordBody.parse(req.body ?? {}).password);
        await deleteBusinessSessions(pool, id);
        return reply(req, res, 200, { reset: true }, null);
      });

      admin.post("/businesses/:id/reset-test-data", async (req, res) => {
        const id = idOf(req);
        if (!(await summaryOf(id)).is_test) throw new ApiError("FORBIDDEN", { message: "Only test businesses can be reset." });
        await resetTestData(pool, id);
        return reply(req, res, 200, { reset: true }, null);
      });

      admin.delete("/businesses/:id", async (req, res) => {
        const id = idOf(req);
        const business = await summaryOf(id);
        const body = deleteBody.parse(req.body ?? {});
        if (body.confirm_name.trim() !== business.name) throw invalid("confirm_name", "type the business name exactly to delete it");
        await deleteBusiness(pool, id);
        return reply(req, res, 200, { deleted: true }, null);
      });

      // "Open its calendar": a Business Panel session for this business, recorded as made by the admin.
      admin.post("/businesses/:id/open", async (req, res) => {
        const business = await summaryOf(idOf(req));
        const token = await createSession(pool, { kind: "business", businessId: business.id, byAdmin: true });
        res.header("set-cookie", sessionCookie(APP_COOKIE, token, opts.cookieSecure));
        return reply(req, res, 200, { opened: true, name: business.name }, null);
      });
    }

    // ================================================================================================================
    // Business Panel
    // ================================================================================================================
    async function appPlugin(panel: FastifyInstance) {
      // A temporary password must be replaced before anything else can be done.
      const ALLOWED_BEFORE_PASSWORD_CHANGE = new Set(["/panel/app/me", "/panel/app/password", "/panel/app/logout"]);

      panel.addHook("onRequest", async (req) => {
        if (req.routeOptions.config.public) return;
        const session = await readSession(pool, parseCookies(req.headers.cookie)[APP_COOKIE], "business");
        const { rows: [b] } = session
          ? await pool.query(
              `SELECT id, name, username, timezone, goes_to_customer, settings, active, must_change_password, staff_label_ar, staff_label_en
                 FROM businesses WHERE id = $1`,
              [session.businessId],
            )
          : { rows: [] };
        if (!b) throw new ApiError("UNAUTHORIZED");
        if (!b.active && !session!.byAdmin) throw new ApiError("ACCOUNT_DISABLED");

        req.business = { id: b.id, name: b.name, timezone: b.timezone, goesToCustomer: b.goes_to_customer, settings: b.settings ?? {} };
        req.sessionHash = session!.tokenHash;
        req.panel = {
          tokenHash: session!.tokenHash,
          byAdmin: session!.byAdmin,
          actor: session!.byAdmin ? "admin" : "business",
          username: b.username,
          mustChangePassword: b.must_change_password,
          staffLabelAr: b.staff_label_ar,
          staffLabelEn: b.staff_label_en,
        };
        if (b.must_change_password && !session!.byAdmin && !ALLOWED_BEFORE_PASSWORD_CHANGE.has(req.routeOptions.url ?? "")) {
          throw new ApiError("PASSWORD_CHANGE_REQUIRED");
        }
      });

      const meData = (req: FastifyRequest, mustChange = req.panel!.mustChangePassword) => ({
        name: req.business!.name,
        username: req.panel!.username,
        must_change_password: mustChange,
        by_admin: req.panel!.byAdmin,
        goes_to_customer: req.business!.goesToCustomer,
        staff_label_ar: req.panel!.staffLabelAr,
        staff_label_en: req.panel!.staffLabelEn,
        timezone: req.business!.timezone,
      });

      panel.post("/login", { config: { public: true } }, async (req, res) => {
        const body = loginBody.parse(req.body ?? {});
        throttleLogin(req, res, body.username);
        const { rows: [b] } = await pool.query(
          `SELECT id, name, username, password_hash, active, must_change_password, goes_to_customer, staff_label_ar, staff_label_en, timezone
             FROM businesses WHERE username = $1`,
          [body.username],
        );
        const ok = b ? await verifyPassword(body.password, b.password_hash) : await verifyAgainstNobody(body.password);
        if (!b || !ok) throw new ApiError("INVALID_CREDENTIALS");
        if (!b.active) throw new ApiError("ACCOUNT_DISABLED");
        const token = await createSession(pool, { kind: "business", businessId: b.id });
        res.header("set-cookie", sessionCookie(APP_COOKIE, token, opts.cookieSecure));
        return reply(req, res, 200, {
          name: b.name, username: b.username, must_change_password: b.must_change_password, by_admin: false,
          goes_to_customer: b.goes_to_customer, staff_label_ar: b.staff_label_ar, staff_label_en: b.staff_label_en, timezone: b.timezone,
        }, null);
      });

      panel.post("/logout", async (req, res) => {
        await deleteSession(pool, req.sessionHash!);
        res.header("set-cookie", clearedCookie(APP_COOKIE, opts.cookieSecure));
        return reply(req, res, 200, { logged_out: true }, null);
      });

      panel.get("/me", async (req, res) => reply(req, res, 200, meData(req), null));

      panel.post("/password", async (req, res) => {
        if (req.panel!.byAdmin) throw new ApiError("FORBIDDEN", { message: "Reset the owner's password from the Admin Panel." });
        const body = z.object({ current_password: z.string().min(1).max(200), new_password: passwordSchema }).strict().parse(req.body ?? {});
        const id = req.business!.id;
        const taken = opts.loginByUser.take(`pw:${id}`); // a stolen session must not be able to guess the current password
        if (!taken.allowed) {
          res.header("retry-after", String(taken.retryAfterSec));
          throw new ApiError("RATE_LIMITED");
        }
        const { rows: [b] } = await pool.query("SELECT password_hash FROM businesses WHERE id = $1", [id]);
        if (!(await verifyPassword(body.current_password, b.password_hash))) throw new ApiError("INVALID_CREDENTIALS");
        if (body.new_password === body.current_password) throw invalid("new_password", "must be different from the current password");

        await pool.query("UPDATE businesses SET password_hash = $2, must_change_password = false WHERE id = $1", [id, await hashPassword(body.new_password)]);
        await deleteBusinessSessions(pool, id, req.panel!.tokenHash); // every other login is closed
        return reply(req, res, 200, meData(req, false), null);
      });

      registerAppPanelRoutes(panel, pool, { now: opts.now, webhookAllowLocal: opts.webhookAllowLocal });
    }
  };
}

export { getBusinessInfo };
