import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { TokenBuckets } from "../src/api/rateLimit.js";
import { BASE, PEPPER, SECRET, auth, shop } from "./fixtures.js";
import { testPool } from "./helpers.js";

const pool = testPool(5);
const ms = { now: 1_000_000 }; // the limiter's own clock, in milliseconds
let limited: FastifyInstance; // 1 request per second, bucket of 3
let normal: FastifyInstance; // production defaults

beforeAll(async () => {
  const base = { apiKeyPepper: PEPPER, slotTokenSecret: SECRET, now: () => BASE };
  limited = await buildApp(pool, { ...base, rateLimit: { perSecond: 1, burst: 3, clock: () => ms.now } });
  normal = await buildApp(pool, { ...base, rateLimit: { clock: () => 0 } }); // production rates, frozen clock: no refill during the test
});
afterAll(async () => {
  await limited.close();
  await normal.close();
  await pool.end();
});

const get = (app: FastifyInstance, key: string) => app.inject({ method: "GET", url: "/v1/business", headers: auth(key) });

describe("TokenBuckets", () => {
  it("spends one token per request, refills over time, and never holds more than the burst", () => {
    let t = 0;
    const b = new TokenBuckets({ perSecond: 2, burst: 4, clock: () => t });
    for (let i = 0; i < 4; i++) expect(b.take("k").allowed).toBe(true);
    const denied = b.take("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(1); // half a second to the next token, rounded up

    t += 500; // one token back
    expect(b.take("k").allowed).toBe(true);
    expect(b.take("k").allowed).toBe(false);

    t += 60_000; // a long pause does not store up more than the burst
    for (let i = 0; i < 4; i++) expect(b.take("k").allowed).toBe(true);
    expect(b.take("k").allowed).toBe(false);
  });

  it("keeps keys apart", () => {
    const b = new TokenBuckets({ perSecond: 1, burst: 1, clock: () => 0 });
    expect(b.take("a").allowed).toBe(true);
    expect(b.take("a").allowed).toBe(false);
    expect(b.take("b").allowed).toBe(true);
  });
});

describe("rate limit on the API", () => {
  it("answers 429 with Retry-After once a business uses up its bucket, and recovers", async () => {
    const s = await shop(pool);
    for (let i = 0; i < 3; i++) expect((await get(limited, s.key)).statusCode).toBe(200);

    const denied = await get(limited, s.key);
    expect(denied.statusCode).toBe(429);
    expect(denied.json()).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", display_ar: null } });
    expect(denied.json().request_id).toMatch(/^req_/);
    expect(denied.headers["retry-after"]).toBe("1");

    ms.now += 1000;
    expect((await get(limited, s.key)).statusCode).toBe(200);
    expect((await get(limited, s.key)).statusCode).toBe(429);
  });

  it("tells every client how much is left, in the standard RateLimit headers", async () => {
    const s = await shop(pool);
    const first = await get(limited, s.key);
    expect(first.headers["ratelimit-policy"]).toBe('"default";q=1;w=1');
    expect(first.headers["ratelimit"]).toBe('"default";r=2;t=1'); // 2 left; the bucket is full again in 1 s
    expect((await get(limited, s.key)).headers["ratelimit"]).toBe('"default";r=1;t=2');
  });

  it("limits each business separately, and requests with a wrong key use nobody's tokens", async () => {
    const a = await shop(pool);
    const b = await shop(pool);
    for (let i = 0; i < 5; i++) await get(limited, a.key);
    expect((await get(limited, a.key)).statusCode).toBe(429);
    expect((await get(limited, b.key)).statusCode).toBe(200);

    for (let i = 0; i < 10; i++) expect((await get(limited, "bk_live_wrong")).statusCode).toBe(401);
  });

  it("does not get in the way of normal use (40 requests in a burst, 20 per second)", async () => {
    const s = await shop(pool);
    for (let i = 0; i < 40; i++) expect((await get(normal, s.key)).statusCode).toBe(200);
    expect((await get(normal, s.key)).statusCode).toBe(429);
  });

  it("never limits /health", async () => {
    for (let i = 0; i < 60; i++) expect((await limited.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});
