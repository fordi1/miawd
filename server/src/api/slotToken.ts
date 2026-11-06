import { createHmac, timingSafeEqual } from "node:crypto";

export const SLOT_TOKEN_TTL_MS = 15 * 60_000;

export interface SlotTokenPayload {
  businessId: string;
  staffId: string;
  serviceId: string;
  zoneId: string | null;
  startsAtMs: number;
}

export type SlotTokenProblem = "invalid" | "expired";

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64url");

/** `st_<payload>.<signature>` — the payload is signed (not secret) and expires after 15 minutes. */
export function signSlotToken(p: SlotTokenPayload, secret: string, nowMs: number): string {
  const body = Buffer.from(
    JSON.stringify({ b: p.businessId, t: p.staffId, v: p.serviceId, z: p.zoneId, s: p.startsAtMs, e: nowMs + SLOT_TOKEN_TTL_MS }),
  ).toString("base64url");
  return `st_${body}.${sign(body, secret)}`;
}

export function verifySlotToken(
  token: string,
  secret: string,
  nowMs: number,
): { payload: SlotTokenPayload } | { problem: SlotTokenProblem } {
  const match = /^st_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return { problem: "invalid" };
  const [, body, sig] = match as unknown as [string, string, string];
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { problem: "invalid" };
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof p.e !== "number" || nowMs > p.e) return { problem: "expired" };
    return { payload: { businessId: p.b, staffId: p.t, serviceId: p.v, zoneId: p.z ?? null, startsAtMs: p.s } };
  } catch {
    return { problem: "invalid" };
  }
}
