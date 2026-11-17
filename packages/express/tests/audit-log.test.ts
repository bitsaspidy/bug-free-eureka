import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  AuditLoggerOptionsError,
  createAuditLogger,
  type AuditEvent,
  type AuditLoggerOptions,
} from "../src/index.js";
import { EXPRESS_VERSIONS } from "./helpers.js";

const CANARY = /BFE_CANARY_/i;

describe.each(EXPRESS_VERSIONS)("audit logger on %s", (_label, express) => {
  function setup(opts: Partial<AuditLoggerOptions> = {}, trustProxy?: unknown) {
    const events: AuditEvent[] = [];
    const logger = createAuditLogger({ sink: (e) => void events.push(e), ...opts });
    const a = express();
    if (trustProxy !== undefined) a.set("trust proxy", trustProxy);
    a.use(logger);
    a.use(express.json({ limit: "2kb" }));
    a.post("/users/:id/login", (_req, res) => {
      res.status(201).json({ ok: true });
    });
    a.get("/slow", (_req, res) => {
      setTimeout(() => res.send("late"), 200);
    });
    return { a, events, logger };
  }

  it("records method, route pattern, status, duration, ip and request id — not the raw URL", async () => {
    const { a, events, logger } = setup();
    await request(a)
      .post("/users/42/login?token=abc")
      .set("x-request-id", "req-1")
      .send({})
      .expect(201);
    await logger.flush();
    expect(events).toHaveLength(1);
    const e = events[0] as AuditEvent;
    expect(e).toMatchObject({
      method: "POST",
      route: "/users/:id/login",
      status: 201,
      requestId: "req-1",
      aborted: false,
    });
    expect(e.ip).toMatch(/127\.0\.0\.1|::1/);
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(e)).not.toContain("token=abc");
    expect(e.headers).toBeUndefined();
    expect(e.body).toBeUndefined();
    expect(e.query).toBeUndefined();
  });

  it("logs a 404 with route null and generates a request id when the header is unsafe", async () => {
    const { a, events, logger } = setup();
    await request(a).get("/nope").set("x-request-id", "bad id <script>").expect(404);
    await logger.flush();
    expect(events[0]?.route).toBeNull();
    expect(events[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("follows req.ip: a spoofed X-Forwarded-For is not logged as the client with trust proxy false", async () => {
    const { a, events, logger } = setup();
    await request(a).get("/nope").set("X-Forwarded-For", "6.6.6.6").expect(404);
    await logger.flush();
    expect(events[0]?.ip).not.toBe("6.6.6.6");
  });

  it("an oversized body is logged as 413 without its content", async () => {
    const { a, events, logger } = setup({ body: true });
    await request(a)
      .post("/users/1/login")
      .set("Content-Type", "application/json")
      .send(`{"password":"BFE_CANARY_PASS_c02e44","pad":"${"x".repeat(5000)}"}`)
      .expect(413);
    await logger.flush();
    expect(events[0]?.status).toBe(413);
    expect(JSON.stringify(events)).not.toMatch(CANARY);
  });

  it("marks aborted requests", async () => {
    const { a, events, logger } = setup();
    await expect(request(a).get("/slow").timeout(30)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    await logger.flush();
    expect(events[0]).toMatchObject({ aborted: true });
  });

  it("redaction-check: no canary reaches the sink, even with headers, query and body enabled", async () => {
    const { a, events, logger } = setup({
      headers: [
        "Authorization",
        "cookie",
        "x-api-key",
        "proxy-authorization",
        "user-agent",
        "x-refresh-token",
        "x-refresh",
      ],
      query: true,
      body: true,
      sensitiveKeys: ["dbUrl", "x-refresh"],
    });
    await request(a)
      .post("/users/1/login?token=BFE_CANARY_TOKEN_7f3a91&page=2")
      .set("Authorization", "Bearer BFE_CANARY_TOKEN_7f3a91")
      .set("Cookie", "sid=BFE_CANARY_COOKIE_9b11d5")
      .set("X-API-KEY", "BFE_CANARY_ENV_a1b2c3")
      .set("Proxy-Authorization", "Basic QkZFX0NBTkFSWV9QQVNTX2MwMmU0NA==")
      .set("User-Agent", "agent Bearer BFE_CANARY_TOKEN_7f3a91")
      .set("X-Refresh-Token", "BFE_CANARY_REFRESH_e5d7c2")
      .set("X-Refresh", "BFE_CANARY_REFRESH_e5d7c2") // custom name, masked via sensitiveKeys
      .send({
        username: "alice",
        PassWord: "BFE_CANARY_PASS_c02e44",
        otp: "BFE_CANARY_OTP_448120",
        tokens: [{ refreshToken: "BFE_CANARY_REFRESH_e5d7c2" }],
        user: { a: { b: { c: { credentials: { password: "BFE_CANARY_PASS_c02e44" } } } } },
        config: {
          DB_PASSWORD: "BFE_CANARY_ENV_a1b2c3",
          API_KEY: "BFE_CANARY_ENV_a1b2c3",
          dbUrl: "BFE_CANARY_ENV_a1b2c3",
        },
        note: 'nested {"password":"BFE_CANARY_PASS_c02e44"}',
      })
      .expect(201);
    await logger.flush();
    const out = JSON.stringify(events);
    expect(out).not.toMatch(CANARY);
    expect(out).not.toContain("QkZFX0NBTkFSWV9QQVNTX2MwMmU0NA");
    // Non-secret context survives.
    expect(events[0]?.body).toMatchObject({ username: "alice" });
    expect(events[0]?.query).toMatchObject({ page: "2" });
    expect(events[0]?.headers).toHaveProperty("authorization", "****");
  });
});

describe("audit logger sink isolation", () => {
  const express = EXPRESS_VERSIONS[0][1];

  it("a throwing or rejecting sink never affects the response and is counted", async () => {
    let n = 0;
    const logger = createAuditLogger({
      sink: () => {
        n += 1;
        if (n % 2) throw new Error("sync fail");
        return Promise.reject(new Error("async fail"));
      },
    });
    const a = express();
    a.use(logger);
    a.get("/x", (_req, res) => {
      res.send("ok");
    });
    await request(a).get("/x").expect(200);
    await request(a).get("/x").expect(200);
    await logger.flush();
    expect(logger.stats()).toEqual({ dropped: 0, failed: 2, queued: 0 });
  });

  it("drops and counts events when the queue is full", async () => {
    const logger = createAuditLogger({
      sink: () => new Promise((r) => setTimeout(r, 5)),
      maxQueue: 2,
    });
    const a = express();
    a.use(logger);
    a.get("/x", (_req, res) => {
      res.send("ok");
    });
    await Promise.all(Array.from({ length: 10 }, () => request(a).get("/x").expect(200)));
    await logger.flush();
    expect(logger.stats().dropped).toBeGreaterThan(0);
    expect(logger.stats().queued).toBe(0);
  });

  it("rejects invalid options at startup", () => {
    expect(() => createAuditLogger({} as never)).toThrow(AuditLoggerOptionsError);
    expect(() => createAuditLogger({ sink: () => {}, maxQueue: 0 })).toThrow(/maxQueue/);
    expect(() => createAuditLogger({ sink: () => {}, extra: 1 } as never)).toThrow(
      AuditLoggerOptionsError,
    );
  });
});
