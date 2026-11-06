import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });

/** log2 of the scrypt cost N: 2^15 = 32 768 (about 32 MiB of memory per hash). */
export const DEFAULT_COST = 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const params = (cost: number): ScryptOptions => ({ N: 2 ** cost, r: R, p: P, maxmem: 256 * 2 ** cost * R });

/** `scrypt$<cost>$<r>$<p>$<salt>$<hash>` — salted, and the cost is stored so it can be raised later. `cost` is only lowered in tests. */
export async function hashPassword(password: string, options: { cost?: number } = {}): Promise<string> {
  const cost = options.cost ?? DEFAULT_COST;
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, params(cost));
  return `scrypt$${cost}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** False for a wrong password and for anything that is not one of our hashes (never throws). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 4 || cost > 20 || Number(parts[2]) !== R || Number(parts[3]) !== P) return false;
  const expected = Buffer.from(parts[5]!, "base64");
  if (expected.length !== KEY_LENGTH) return false;
  try {
    const actual = await scrypt(password.normalize("NFKC"), Buffer.from(parts[4]!, "base64"), KEY_LENGTH, params(cost));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** A password check that always fails but takes as long as a real one, so an unknown username cannot be told apart by timing. */
export async function verifyAgainstNobody(password: string): Promise<false> {
  dummy ??= hashPassword("not-a-real-account-password");
  await verifyPassword(password, await dummy);
  return false;
}
