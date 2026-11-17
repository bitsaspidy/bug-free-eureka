import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { maskSecrets } from "@bug-free-eureka/core";
import { z } from "zod";
import { createMemoryStore, type RateLimitHit, type RateLimitStore } from "./stores.js";
import type { BfeLogger, BfeMiddleware, BfeRequest } from "./types.js";

export type StoreErrorMode = "fail-open" | "fail-closed";

export interface RateLimitOptions {
  /** Sliding window length in ms. Default 60000. */
  windowMs?: number;
  /** Requests allowed per window and key. Default 100. */
  limit?: number;
  /** Counter storage. Default: a new in-memory store (single instance only). */
  store?: RateLimitStore;
  /**
   * What happens when the store errors or exceeds `storeTimeoutMs`.
   * "fail-open" (default) lets the request through; "fail-closed" answers 503.
   * Prefer "fail-closed" for login and other brute-force targets.
   */
  onStoreError?: StoreErrorMode;
  /** Store call timeout in ms. Default 100. */
  storeTimeoutMs?: number;
  /**
   * Builds the rate-limit key. Default: `req.ip` (IPv6 grouped to /64). The
   * result is hashed before it reaches the store. Return `undefined` to use
   * the default key.
   */
  keyGenerator?: (req: BfeRequest) => string | undefined;
  /** Skip limiting for a request (e.g. health checks). */
  skip?: (req: BfeRequest) => boolean;
  /** Send IETF `RateLimit-Policy` and `RateLimit` headers on every response. Default false. */
  standardHeaders?: boolean;
  /** Plain-text body of the 429 response. Default "Too Many Requests". */
  message?: string;
  /** Receives diagnostics (store errors, unsafe trust proxy). At most one per type per minute. */
  logger?: BfeLogger;
  /** Policy name used in headers and to namespace keys. Default "default". */
  name?: string;
  /** Clock, for tests. Default Date.now. */
  now?: () => number;
}

const fn = () =>
  z
    .custom<(...args: never[]) => unknown>((v) => typeof v === "function", "must be a function")
    .optional();

const optionsSchema = z
  .object({
    windowMs: z.number().int().min(1000).max(86_400_000).default(60_000),
    limit: z.number().int().min(1).max(1_000_000_000).default(100),
    store: z
      .custom<RateLimitStore>(
        (s) => typeof (s as RateLimitStore | undefined)?.hit === "function",
        "store must implement hit(key, windowMs, now)",
      )
      .optional(),
    onStoreError: z.enum(["fail-open", "fail-closed"]).default("fail-open"),
    storeTimeoutMs: z.number().int().min(1).max(60_000).default(100),
    keyGenerator: fn(),
    skip: fn(),
    standardHeaders: z.boolean().default(false),
    message: z.string().max(1000).default("Too Many Requests"),
    logger: fn(),
    name: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .default("default"),
    now: fn(),
  })
  .strict();

export class RateLimitOptionsError extends Error {
  readonly code = "BFE_RATE_LIMIT_OPTIONS";
  constructor(detail: string) {
    super(`Invalid rate limiter options: ${detail}`);
    this.name = "RateLimitOptionsError";
  }
}

export class StoreTimeoutError extends Error {
  readonly code = "BFE_STORE_TIMEOUT";
  constructor(ms: number) {
    super(`Rate-limit store did not answer within ${ms} ms.`);
    this.name = "StoreTimeoutError";
  }
}

/**
 * Client key from an IP: IPv4-mapped IPv6 becomes IPv4; other IPv6 addresses
 * are grouped to their /64 network, because one client usually controls a
 * whole /64. Anything that is not an IP is kept as-is.
 */
export function ipKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  if (isIP(ip) !== 6) return ip;
  const g = ipv6Groups(ip);
  if (!g) return ip;
  // IPv4-mapped (::ffff:a.b.c.d in any notation) and NAT64 (64:ff9b::/96) carry
  // one IPv4 client each: key them by that IPv4 address.
  const zero5 = g.slice(0, 5).every((x) => x === 0);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  if ((zero5 && g[5] === 0xffff) || nat64) {
    const [hi = 0, lo = 0] = g.slice(6);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

/** Expands a valid IPv6 address (already checked with isIP) to 8 numbers. */
function ipv6Groups(ip: string): number[] | null {
  let s = (ip.split("%")[0] as string).toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail = ""] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const missing = s.includes("::") ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array<string>(Math.max(0, missing)).fill("0"), ...t].map((x) =>
    Number.parseInt(x, 16),
  );
  return groups.length === 8 && groups.every((x) => Number.isInteger(x)) ? groups : null;
}

function hashKey(name: string, key: string): string {
  return createHash("sha256").update(`${name}\0${key}`).digest("base64url").slice(0, 32);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new StoreTimeoutError(ms)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error("Rate-limit store failed."));
      },
    );
  });
}

function throttledLogger(logger: BfeLogger | undefined, now: () => number): BfeLogger {
  const last = new Map<string, { at: number; suppressed: number }>();
  return (event) => {
    if (!logger) return;
    const t = now();
    const prev = last.get(event.type);
    if (prev && t - prev.at < 60_000) {
      prev.suppressed += 1;
      return;
    }
    last.set(event.type, { at: t, suppressed: 0 });
    try {
      logger(prev?.suppressed ? { ...event, suppressed: prev.suppressed } : event);
    } catch {
      // A failing logger must never affect the request.
    }
  };
}

/**
 * Opt-in rate limiter (sliding-window counter). Keys on `req.ip`, so it
 * follows your `trust proxy` setting and never parses forwarded headers itself.
 */
export function createRateLimiter(options: RateLimitOptions = {}): BfeMiddleware {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new RateLimitOptionsError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "options"}: ${i.message}`).join("; "),
    );
  }
  const o = parsed.data;
  const now = options.now ?? Date.now;
  const store = options.store ?? createMemoryStore();
  const keyGenerator = options.keyGenerator;
  const skip = options.skip;
  const log = throttledLogger(options.logger, now);
  const policy = `"${o.name}";q=${o.limit};w=${Math.ceil(o.windowMs / 1000)}`;
  let trustProxyChecked = false;

  return (req, res, next) => {
    if (!trustProxyChecked) {
      trustProxyChecked = true;
      if (req.app?.get("trust proxy") === true) {
        log({
          type: "trust_proxy_true",
          message:
            "trust proxy is true: every client can choose req.ip via X-Forwarded-For and bypass the rate limiter. Set it to the exact hop count or proxy addresses.",
        });
      }
    }
    try {
      if (skip?.(req)) {
        next();
        return;
      }
    } catch (err) {
      next(err);
      return;
    }

    let raw: string | undefined;
    try {
      raw = keyGenerator?.(req);
    } catch (err) {
      next(err);
      return;
    }
    const key = hashKey(o.name, typeof raw === "string" && raw ? raw : ipKey(req.ip));
    const t = now();

    let hit: Promise<RateLimitHit>;
    try {
      hit = store.hit(key, o.windowMs, t);
    } catch (err) {
      hit = Promise.reject(err instanceof Error ? err : new Error("Rate-limit store failed."));
    }
    withTimeout(hit, o.storeTimeoutMs).then(
      ({ current, previous }) => {
        const elapsed = (t % o.windowMs) / o.windowMs;
        const count = Math.floor(previous * (1 - elapsed)) + current;
        const remaining = Math.max(0, o.limit - count);
        const resetSec = Math.max(1, Math.ceil((o.windowMs - (t % o.windowMs)) / 1000));
        if (res.headersSent) {
          next();
          return;
        }
        if (o.standardHeaders) {
          res.setHeader("RateLimit-Policy", policy);
          res.setHeader("RateLimit", `"${o.name}";r=${remaining};t=${resetSec}`);
        }
        if (count > o.limit) {
          res.statusCode = 429;
          res.setHeader("Retry-After", String(resetSec));
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(o.message);
          return;
        }
        next();
      },
      (err: unknown) => {
        log({
          type: "store_error",
          message: maskSecrets(
            `Rate-limit store unavailable (${o.onStoreError}): ${err instanceof Error ? err.message : "unknown error"}`,
          ),
        });
        if (o.onStoreError === "fail-closed" && !res.headersSent) {
          res.statusCode = 503;
          res.setHeader("Retry-After", "1");
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Service Unavailable");
          return;
        }
        next();
      },
    );
  };
}
