import { randomUUID } from "node:crypto";
import { maskSecrets, redact, redactHeaders } from "@bug-free-eureka/core";
import { z } from "zod";
import type { BfeMiddleware, BfeRequest, BfeResponse } from "./types.js";

export interface AuditEvent {
  time: string;
  requestId: string;
  method: string;
  /** Matched route pattern (e.g. "/users/:id"), never the raw URL. null if no route matched. */
  route: string | null;
  status: number;
  durationMs: number;
  ip: string | null;
  /** True when the connection closed before the response finished. */
  aborted: boolean;
  /** Only the headers listed in `headers`, redacted. */
  headers?: Record<string, unknown>;
  /** Redacted `req.query`, only with `query: true`. */
  query?: unknown;
  /** Redacted `req.body`, only with `body: true`. */
  body?: unknown;
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

export interface AuditLoggerOptions {
  /** Receives one redacted event per request, asynchronously, after the response. */
  sink: AuditSink;
  /**
   * Request headers to include (allowlist, case-insensitive). Default none.
   * Sensitive ones (authorization, cookie, x-api-key, …) are always masked.
   */
  headers?: string[];
  /** Include redacted `req.query`. Default false. */
  query?: boolean;
  /** Include redacted `req.body`. Default false. */
  body?: boolean;
  /** Extra key names to mask in headers, query and body. */
  sensitiveKeys?: string[];
  /** Max events waiting for the sink; extra events are dropped and counted. Default 1000. */
  maxQueue?: number;
}

export interface AuditLoggerStats {
  /** Events dropped because the queue was full. */
  dropped: number;
  /** Sink calls that threw or rejected. */
  failed: number;
  /** Events waiting for the sink. */
  queued: number;
}

export type AuditLoggerMiddleware = BfeMiddleware & {
  stats(): AuditLoggerStats;
  /** Resolves once every queued event has been handed to the sink. */
  flush(): Promise<void>;
};

const optionsSchema = z
  .object({
    sink: z.custom<AuditSink>((v) => typeof v === "function", "sink must be a function"),
    headers: z.array(z.string().min(1).max(256)).max(100).default([]),
    query: z.boolean().default(false),
    body: z.boolean().default(false),
    sensitiveKeys: z.array(z.string().min(1).max(256)).max(100).default([]),
    maxQueue: z.number().int().min(1).max(1_000_000).default(1000),
  })
  .strict();

export class AuditLoggerOptionsError extends Error {
  readonly code = "BFE_AUDIT_OPTIONS";
  constructor(detail: string) {
    super(`Invalid audit logger options: ${detail}`);
    this.name = "AuditLoggerOptionsError";
  }
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

function routeOf(req: BfeRequest): string | null {
  const p = req.route?.path;
  if (p === undefined || p === null) return null;
  const path = typeof p === "string" ? p : Array.isArray(p) ? p.map(String).join(",") : String(p);
  return maskSecrets(`${req.baseUrl ?? ""}${path}`).slice(0, 512);
}

/**
 * Opt-in audit logger. Records method, route pattern, status, duration,
 * `req.ip` and a request ID when the response finishes (or the connection
 * closes). Bodies, queries and headers are excluded unless enabled, and are
 * always redacted through core's `redact`/`redactHeaders` before the sink.
 * Raw auth headers, cookies, passwords, OTPs and tokens are never logged.
 */
export function createAuditLogger(options: AuditLoggerOptions): AuditLoggerMiddleware {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new AuditLoggerOptionsError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "options"}: ${i.message}`).join("; "),
    );
  }
  const o = parsed.data;
  const sink = options.sink;
  const wanted = new Set(o.headers.map((h) => h.toLowerCase()));
  const redactOpts = { extraKeys: o.sensitiveKeys };
  const queue: AuditEvent[] = [];
  const stats = { dropped: 0, failed: 0 };
  let draining: Promise<void> | null = null;

  async function drain(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    while (queue.length > 0) {
      const event = queue.shift() as AuditEvent;
      try {
        await sink(event);
      } catch {
        stats.failed += 1; // A sink failure never affects the app.
      }
    }
    draining = null;
  }

  function enqueue(event: AuditEvent): void {
    if (queue.length >= o.maxQueue) {
      stats.dropped += 1;
      return;
    }
    queue.push(event);
    draining ??= drain();
  }

  function build(req: BfeRequest, res: BfeResponse, id: string, start: bigint): AuditEvent {
    const event: AuditEvent = {
      time: new Date().toISOString(),
      requestId: id,
      method: String(req.method ?? "").slice(0, 32),
      route: routeOf(req),
      status: res.statusCode,
      durationMs: Number((process.hrtime.bigint() - start) / 1000n) / 1000,
      ip: req.ip ?? null,
      aborted: !res.writableFinished,
    };
    if (wanted.size > 0) {
      const picked: Record<string, unknown> = {};
      for (const name of wanted) {
        const v = req.headers[name];
        if (v !== undefined) picked[name] = v;
      }
      event.headers = redactHeaders(picked, redactOpts);
    }
    if (o.query) event.query = redact(req.query, redactOpts);
    if (o.body) event.body = redact(req.body, redactOpts);
    return event;
  }

  const middleware = ((req, res, next) => {
    const start = process.hrtime.bigint();
    const header = req.headers["x-request-id"];
    const id = typeof header === "string" && REQUEST_ID.test(header) ? header : randomUUID();
    if (res.locals) res.locals.bfe = { ...(res.locals.bfe as object | undefined), requestId: id };
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      res.removeListener("finish", finish);
      res.removeListener("close", finish);
      try {
        enqueue(build(req, res, id, start));
      } catch {
        stats.failed += 1;
      }
    };
    res.on("finish", finish);
    res.on("close", finish);
    next();
  }) as AuditLoggerMiddleware;

  middleware.stats = () => ({ ...stats, queued: queue.length });
  middleware.flush = async () => {
    while (draining) await draining;
  };
  return middleware;
}
