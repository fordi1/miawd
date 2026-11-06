import { createHmac, randomBytes } from "node:crypto";

/** Standard Webhooks secret: `whsec_` + base64 of 24 random bytes. */
export const generateWebhookSecret = () => `whsec_${randomBytes(24).toString("base64")}`;

/**
 * Standard Webhooks signature (https://github.com/standard-webhooks/standard-webhooks): HMAC-SHA256 over
 * `<message id>.<unix timestamp>.<body>` with the base64-decoded secret, base64 encoded, prefixed `v1,`.
 */
export function signWebhook(secret: string, messageId: string, timestampSec: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${messageId}.${timestampSec}.${body}`).digest("base64")}`;
}
