import { lookup } from "node:dns/promises";
import net from "node:net";

/** True for addresses that must never be called from our server: loopback, private, link-local, multicast… */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local (cloud metadata lives here)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      x === "::" || x === "::1" || x.startsWith("::ffff:") ||
      /^f[cd]/.test(x) || // unique local fc00::/7
      /^fe[89ab]/.test(x) || // link-local fe80::/10
      x.startsWith("ff") // multicast
    );
  }
  return false;
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|lan|home)$/;

/**
 * Checks a webhook URL a business wants us to call. Production: https only, no credentials in the URL, no
 * localhost / private addresses. `allowLocal` (tests and local development only) also allows http and local hosts.
 * Returns the normalized URL, or throws an Error saying what is wrong.
 */
export function validateWebhookUrl(text: string, allowLocal: boolean): string {
  if (text.length > 500) throw new Error("must be at most 500 characters");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("is not a valid URL");
  }
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:")) throw new Error("must start with https://");
  if (url.username || url.password) throw new Error("must not contain a username or password");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new Error("has no host");
  if (!allowLocal && (LOCAL_NAMES.test(host) || isPrivateAddress(host))) throw new Error("must point to a public host");
  return url.toString();
}

/** Refuses a host that resolves to a private address (checked again at delivery time, not only when saved). */
export async function assertResolvesPublic(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error("blocked: the host resolves to a private address");
}
