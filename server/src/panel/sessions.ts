import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

export const ADMIN_COOKIE = "mawid_admin";
export const APP_COOKIE = "mawid_app";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export type SessionKind = "admin" | "business";

export interface Session {
  tokenHash: string;
  kind: SessionKind;
  adminId: string | null;
  businessId: string | null;
  byAdmin: boolean;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Opens a session and returns its token (the only time it exists in clear: it goes into the cookie). */
export async function createSession(
  pool: pg.Pool,
  input: { kind: SessionKind; adminId?: string; businessId?: string; byAdmin?: boolean },
): Promise<string> {
  await pool.query("DELETE FROM sessions WHERE expires_at < now()"); // housekeeping
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (token_hash, kind, admin_id, business_id, by_admin, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [hashToken(token), input.kind, input.adminId ?? null, input.businessId ?? null, input.byAdmin ?? false, SESSION_TTL_SECONDS],
  );
  return token;
}

/** The session behind a cookie token, if it exists, has not expired and is of the expected kind. */
export async function readSession(pool: pg.Pool, token: string | undefined, kind: SessionKind): Promise<Session | null> {
  if (!token) return null;
  const { rows: [r] } = await pool.query(
    "SELECT token_hash, kind, admin_id, business_id, by_admin FROM sessions WHERE token_hash = $1 AND kind = $2 AND expires_at > now()",
    [hashToken(token), kind],
  );
  return r ? { tokenHash: r.token_hash, kind: r.kind, adminId: r.admin_id, businessId: r.business_id, byAdmin: r.by_admin } : null;
}

export const deleteSession = (pool: pg.Pool, tokenHash: string) => pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);

/** Closes every session of a business's panel (optionally keeping one: the one that is changing the password). */
export const deleteBusinessSessions = (pool: pg.Pool, businessId: string, exceptTokenHash?: string) =>
  pool.query("DELETE FROM sessions WHERE business_id = $1 AND token_hash IS DISTINCT FROM $2", [businessId, exceptTokenHash ?? null]);

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return cookies;
}

/** `Secure` is added when the server is reached over https (production). SameSite=Strict keeps other websites from using it. */
export const sessionCookie = (name: string, token: string, secure: boolean) =>
  `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
export const clearedCookie = (name: string, secure: boolean) => `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
