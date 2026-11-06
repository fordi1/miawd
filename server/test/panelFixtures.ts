import type { FastifyInstance, InjectOptions } from "fastify";
import type pg from "pg";
import { createAdmin } from "../src/auth/admins.js";
import { auth } from "./fixtures.js";

export const ADMIN_PASSWORD = "correct horse battery";
export const TEMP_PASSWORD = "temp-pass-123";
export const OWNER_PASSWORD = "my-new-password-1";
const uniq = () => Math.random().toString(36).slice(2, 10);

/** The "name=value" part of a Set-Cookie header. */
export function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = ([] as string[]).concat((res.headers["set-cookie"] as string | string[] | undefined) ?? []).find((c) => c.startsWith(`${name}=`));
  return raw ? raw.split(";")[0]! : null;
}

export function panelClient(app: FastifyInstance, pool: pg.Pool) {
  const send = (method: InjectOptions["method"], url: string, cookie: string | null, payload?: Record<string, unknown>, query?: Record<string, string>) =>
    app.inject({ method, url, headers: { ...(cookie && { cookie }) }, ...(payload && { payload }), ...(query && { query }) });

  async function adminCookie() {
    const username = `admin_${uniq()}`;
    await createAdmin(pool, username, ADMIN_PASSWORD, { cost: 10 });
    const r = await send("POST", "/panel/admin/login", null, { username, password: ADMIN_PASSWORD });
    return cookieFrom(r, "mawid_admin")!;
  }

  /** A business made by the admin (sample data when `is_test`), plus an owner who has already replaced the temporary password. */
  async function owner(extra: Record<string, unknown> = {}, opts: { changePassword?: boolean } = {}) {
    const admin = await adminCookie();
    const username = `biz_${uniq()}`;
    const created = await send("POST", "/panel/admin/businesses", admin, {
      name: "مؤسسة النور", username, password: TEMP_PASSWORD, goes_to_customer: true, is_test: true, staff_label_ar: "فني", staff_label_en: "Technician", ...extra,
    });
    if (created.statusCode !== 201) throw new Error(`create business failed: ${created.body}`);
    const businessId = created.json().data.business.id as string;
    const key = created.json().data.api_key as string;

    const login = await send("POST", "/panel/app/login", null, { username, password: TEMP_PASSWORD });
    let cookie = cookieFrom(login, "mawid_app")!;
    if (opts.changePassword !== false) {
      const changed = await send("POST", "/panel/app/password", cookie, { current_password: TEMP_PASSWORD, new_password: OWNER_PASSWORD });
      if (changed.statusCode !== 200) throw new Error(`password change failed: ${changed.body}`);
    }
    return { admin, businessId, key, username, cookie };
  }

  /** A booking made through the public API tomorrow (Sunday 8 Nov) at `time`, like the bot would. */
  async function botBooking(key: string, time: string, extra: Record<string, unknown> = {}) {
    const found = (await app.inject({
      method: "POST", url: "/v1/availability/check", headers: auth(key),
      payload: { service: "ثلاجة", zone: "هاشمي شمالي", date: "بكرا", time },
    })).json().data;
    const r = await app.inject({
      method: "POST", url: "/v1/bookings", headers: auth(key),
      payload: { slot_token: found.slot_token, customer_name: "سامر", customer_phone: "0795550100", ...extra },
    });
    if (r.statusCode !== 201) throw new Error(`bot booking failed: ${r.body}`);
    return r.json().data as { id: string; staff_id: string; service_id: string; zone_id: string; start_at: string };
  }

  return { send, adminCookie, owner, botBooking };
}
