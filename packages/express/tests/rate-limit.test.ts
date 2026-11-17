import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryStore,
  createRateLimiter,
  createRedisStore,
  ipKey,
  RateLimitOptionsError,
  RedisStoreReplyError,
  type BfeLogEvent,
  type RateLimitOptions,
} from "../src/index.js";
import { EXPRESS_VERSIONS, FakeRedis, manualClock } from "./helpers.js";

describe.each(EXPRESS_VERSIONS)("rate limiter on %s", (_label, express) => {
  function app(opts: RateLimitOptions, trustProxy?: unknown) {
    const a = express();
    if (trustProxy !== undefined) a.set("trust proxy", trustProxy);
    a.use(createRateLimiter(opts));
    a.get("/x", (_req, res) => {
      res.send("ok");
    });
    a.post("/json", express.json({ limit: "1kb" }), (_req, res) => {
      res.send("ok");
    });
    return a;
  }

  it("allows up to the limit, then answers 429 with Retry-After and no internals", async () => {
    const a = app({ limit: 3, now: manualClock().now });
    for (let i = 0; i < 3; i++) await request(a).get("/x").expect(200);
    const res = await request(a).get("/x").expect(429);
    expect(res.text).toBe("Too Many Requests");
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(res.headers["ratelimit"]).toBeUndefined(); // standard headers are opt-in
  });

  it("sends IETF RateLimit headers only when enabled", async () => {
    const a = app({ limit: 2, standardHeaders: true, now: manualClock().now });
    const res = await request(a).get("/x").expect(200);
    expect(res.headers["ratelimit-policy"]).toBe('"default";q=2;w=60');
    expect(res.headers["ratelimit"]).toBe('"default";r=1;t=60');
  });

  it("sliding window: the previous window still counts, weighted by overlap", async () => {
    const clock = manualClock();
    const a = app({ limit: 4, now: clock.now });
    for (let i = 0; i < 4; i++) await request(a).get("/x").expect(200);
    clock.advance(60_000 + 15_000); // 25% into the next window: 75% of 4 = 3 still count
    await request(a).get("/x").expect(200); // 3 + 1 = 4
    await request(a).get("/x").expect(429); // 3 + 2 = 5
    clock.advance(30_000); // 75% in: floor(4 * 0.25) = 1; rejected hits count too
    await request(a).get("/x").expect(200); // 1 + 3 = 4
    await request(a).get("/x").expect(429); // 1 + 4 = 5
    clock.advance(60_000); // two windows later the old counts are gone
    await request(a).get("/x").expect(200);
  });

  it("skip() bypasses only the requests it selects", async () => {
    const a = app({
      limit: 1,
      skip: (req) => req.headers["x-health"] === "1",
      now: manualClock().now,
    });
    await request(a).get("/x").expect(200);
    await request(a).get("/x").set("x-health", "1").expect(200);
    await request(a).get("/x").expect(429);
  });

  it("custom keyGenerator separates buckets", async () => {
    const a = app({
      limit: 1,
      keyGenerator: (req) =>
        String(req.headers["x-user"] ?? "")
          .trim()
          .toLowerCase(),
      now: manualClock().now,
    });
    await request(a).get("/x").set("x-user", "alice").expect(200);
    await request(a).get("/x").set("x-user", " Alice").expect(429); // normalised by the app's generator
    await request(a).get("/x").set("x-user", "bob").expect(200);
  });

  describe("store outage", () => {
    it("fail-open (default) lets requests through and reports once, without secrets or keys", async () => {
      const redis = new FakeRedis();
      redis.down = true;
      const events: BfeLogEvent[] = [];
      const a = app({
        limit: 1,
        store: createRedisStore({ eval: redis.eval }),
        logger: (e) => events.push(e),
      });
      for (let i = 0; i < 3; i++) await request(a).get("/x").expect(200);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("store_error");
      expect(events[0]?.message).toContain("fail-open");
      expect(events[0]?.message).not.toMatch(/127\.0\.0\.1|::1/);
    });

    it("fail-closed answers 503", async () => {
      const redis = new FakeRedis();
      redis.down = true;
      const a = app({ store: createRedisStore({ eval: redis.eval }), onStoreError: "fail-closed" });
      const res = await request(a).get("/x").expect(503);
      expect(res.text).toBe("Service Unavailable");
    });

    it("a store slower than storeTimeoutMs counts as down", async () => {
      const redis = new FakeRedis();
      redis.delayMs = 300;
      const open = app({ store: createRedisStore({ eval: redis.eval }), storeTimeoutMs: 20 });
      await request(open).get("/x").expect(200);
      const closed = app({
        store: createRedisStore({ eval: redis.eval }),
        storeTimeoutMs: 20,
        onStoreError: "fail-closed",
      });
      await request(closed).get("/x").expect(503);
    });

    it("outage mid-burst, then recovery, keeps counting in the shared store", async () => {
      const redis = new FakeRedis();
      const clock = manualClock();
      const a = app({ limit: 2, store: createRedisStore({ eval: redis.eval }), now: clock.now });
      await request(a).get("/x").expect(200);
      redis.down = true;
      await request(a).get("/x").expect(200); // fail-open, not counted
      redis.down = false;
      await request(a).get("/x").expect(200);
      await request(a).get("/x").expect(429);
    });

    it("a store that throws synchronously is handled like an outage", async () => {
      const a = app({
        store: {
          hit: () => {
            throw new Error("boom");
          },
        },
        onStoreError: "fail-closed",
      });
      await request(a).get("/x").expect(503);
    });
  });

  describe("multi-instance with a shared store", () => {
    it("two app instances sharing one Redis share the count", async () => {
      const redis = new FakeRedis();
      const clock = manualClock();
      const a = app({ limit: 3, store: createRedisStore({ eval: redis.eval }), now: clock.now });
      const b = app({ limit: 3, store: createRedisStore({ eval: redis.eval }), now: clock.now });
      await request(a).get("/x").expect(200);
      await request(b).get("/x").expect(200);
      await request(a).get("/x").expect(200);
      await request(b).get("/x").expect(429);
      await request(a).get("/x").expect(429);
    });

    it("separate in-memory stores do not share counts (documented limitation)", async () => {
      const clock = manualClock();
      const a = app({ limit: 1, now: clock.now });
      const b = app({ limit: 1, now: clock.now });
      await request(a).get("/x").expect(200);
      await request(b).get("/x").expect(200);
    });

    it("200 parallel requests across two instances never exceed the limit", async () => {
      const redis = new FakeRedis();
      const clock = manualClock();
      const a = app({ limit: 50, store: createRedisStore({ eval: redis.eval }), now: clock.now });
      const b = app({ limit: 50, store: createRedisStore({ eval: redis.eval }), now: clock.now });
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) => request(i % 2 ? a : b).get("/x")),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(50);
      expect(results.filter((r) => r.status === 429)).toHaveLength(150);
    });

    it("Redis keys are namespaced and never contain the raw client IP", async () => {
      const redis = new FakeRedis();
      const a = app({ limit: 5, store: createRedisStore({ eval: redis.eval }) }, 1);
      await request(a).get("/x").set("X-Forwarded-For", "203.0.113.9").expect(200);
      const keys = [...redis.data.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^bfe:rl:60000:[A-Za-z0-9_-]{32}:\d+$/);
      expect(keys.join()).not.toContain("203.0.113.9");
    });
  });

  describe("adversarial: forwarded headers", () => {
    it("trust proxy false (default): rotating X-Forwarded-For does not reset the limit", async () => {
      const a = app({ limit: 2, now: manualClock().now });
      await request(a).get("/x").set("X-Forwarded-For", "1.1.1.1").expect(200);
      await request(a).get("/x").set("X-Forwarded-For", "2.2.2.2").expect(200);
      await request(a).get("/x").set("X-Forwarded-For", "3.3.3.3").expect(429);
      await request(a)
        .get("/x")
        .set("X-Real-IP", "4.4.4.4")
        .set("Forwarded", "for=5.5.5.5")
        .expect(429);
    });

    it("trust proxy 1: forged entries before the proxy-appended address are ignored", async () => {
      const a = app({ limit: 1, now: manualClock().now }, 1);
      await request(a).get("/x").set("X-Forwarded-For", "1.1.1.1, 9.9.9.9").expect(200);
      await request(a).get("/x").set("X-Forwarded-For", "2.2.2.2, 9.9.9.9").expect(429);
      await request(a).get("/x").set("X-Forwarded-For", "8.8.8.8").expect(200); // a different real client
    });

    it("a 10 KB garbage X-Forwarded-For neither crashes nor changes the key", async () => {
      const a = app({ limit: 1, now: manualClock().now });
      await request(a).get("/x").set("X-Forwarded-For", "x".repeat(10_000)).expect(200);
      await request(a).get("/x").set("X-Forwarded-For", "y,".repeat(5000)).expect(429);
    });

    it("rotating IPv6 addresses inside one /64 share a bucket", async () => {
      const a = app({ limit: 1, now: manualClock().now }, 1);
      await request(a).get("/x").set("X-Forwarded-For", "2001:db8:1:2::1").expect(200);
      await request(a).get("/x").set("X-Forwarded-For", "2001:db8:1:2:ffff:1:2:3").expect(429);
      await request(a).get("/x").set("X-Forwarded-For", "2001:db8:1:3::1").expect(200);
    });

    it("warns once when trust proxy is true (clients choose req.ip)", async () => {
      const events: BfeLogEvent[] = [];
      const a = app({ logger: (e) => events.push(e) }, true);
      await request(a).get("/x").expect(200);
      await request(a).get("/x").expect(200);
      expect(events.map((e) => e.type)).toEqual(["trust_proxy_true"]);
    });
  });

  describe("adversarial: oversized requests", () => {
    it("an oversized body gets 413 from the parser and still counts toward the limit", async () => {
      const a = app({ limit: 2, now: manualClock().now });
      await request(a)
        .post("/json")
        .set("Content-Type", "application/json")
        .send(`{"a":"${"x".repeat(5000)}"}`)
        .expect(413);
      await request(a).post("/json").send({ a: 1 }).expect(200);
      await request(a).post("/json").send({ a: 1 }).expect(429);
    });

    it("the limiter answers 429 before the body parser reads an oversized body", async () => {
      const a = app({ limit: 1, now: manualClock().now });
      await request(a).get("/x").expect(200);
      await request(a)
        .post("/json")
        .set("Content-Type", "application/json")
        .send(`{"a":"${"x".repeat(50_000)}"}`)
        .expect(429);
    });
  });
});

describe("rate limiter options and helpers", () => {
  it("rejects invalid options at startup with a typed error", () => {
    expect(() => createRateLimiter({ limit: 0 })).toThrow(RateLimitOptionsError);
    expect(() => createRateLimiter({ windowMs: 10 })).toThrow(/windowMs/);
    expect(() => createRateLimiter({ onStoreError: "maybe" as never })).toThrow(/onStoreError/);
    expect(() => createRateLimiter({ store: {} as never })).toThrow(/store/);
    expect(() => createRateLimiter({ unknown: 1 } as never)).toThrow(RateLimitOptionsError);
  });

  it("ipKey groups IPv6 to /64, unwraps IPv4-mapped addresses and keeps IPv4", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("2001:db8:a:b:c:d:e:f")).toBe("2001:db8:a:b::/64");
    expect(ipKey("2001:DB8:A:B::1")).toBe("2001:db8:a:b::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipKey(undefined)).toBe("unknown");
    expect(ipKey("not-an-ip")).toBe("not-an-ip");
  });

  it("memory store stays bounded under many unique keys", async () => {
    const store = createMemoryStore({ maxKeys: 1000 });
    for (let i = 0; i < 100_000; i++) await store.hit(`k${i}`, 60_000, 0);
    expect(store.size()).toBeLessThanOrEqual(1000);
    expect(await store.hit("k99999", 60_000, 0)).toEqual({ current: 2, previous: 0 });
  });

  it("memory store reset forgets a key", async () => {
    const store = createMemoryStore();
    await store.hit("a", 1000, 0);
    await store.reset?.("a", 1000, 0);
    expect(await store.hit("a", 1000, 0)).toEqual({ current: 1, previous: 0 });
  });

  it("redis store validates its client and replies", async () => {
    expect(() => createRedisStore({} as never)).toThrow(TypeError);
    const bad = createRedisStore({ eval: () => Promise.resolve("OK") });
    await expect(bad.hit("k", 1000, 0)).rejects.toThrow(RedisStoreReplyError);
    const neg = createRedisStore({ eval: () => Promise.resolve([-1, 0]) });
    await expect(neg.hit("k", 1000, 0)).rejects.toThrow(RedisStoreReplyError);
    const strings = createRedisStore({ eval: () => Promise.resolve(["2", "1"]) });
    expect(await strings.hit("k", 1000, 0)).toEqual({ current: 2, previous: 1 });
  });

  it("redis store reset deletes both window keys under the prefix", async () => {
    const redis = new FakeRedis();
    const store = createRedisStore({ eval: redis.eval, prefix: "app:" });
    await store.hit("k", 1000, 5000);
    expect([...redis.data.keys()]).toEqual(["app:1000:k:5"]);
    await store.reset?.("k", 1000, 5000);
    expect(redis.data.size).toBe(0);
  });

  it("a throwing logger never breaks the request path", async () => {
    const express = EXPRESS_VERSIONS[0][1];
    const a = express();
    a.use(
      createRateLimiter({
        store: { hit: () => Promise.reject(new Error("down")) },
        logger: vi.fn(() => {
          throw new Error("logger broke");
        }),
      }),
    );
    a.get("/x", (_req, res) => {
      res.send("ok");
    });
    await request(a).get("/x").expect(200);
  });
});
