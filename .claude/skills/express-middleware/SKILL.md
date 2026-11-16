---
name: express-middleware
description: Express 4/5 expertise for Bug-Free Eureka — middleware contracts, async errors, trust proxy and req.ip, body limits, security headers, CORS, cookies/sessions, rate-limiting algorithms with in-memory and Redis-compatible stores, fail-open/closed, audit logging with redaction, Supertest patterns. Use when building packages/express, designing rules BFE-001..008, or reviewing Express code.
---

# Express expertise

The npm latest on 2026-11-16 is express 5.3. Support **both** majors: `peerDependencies: { "express": "^4.21.0 || ^5.0.0" }`. CI tests both via a dev alias (`"express4": "npm:express@^4.21.0"`).

## Middleware contract
* Factory pattern: `createX(options) → (req, res, next) => void`. Validate options with Zod **in the factory** (fail at startup, not per request).
* Call `next()` exactly once, or end the response, never both. Pass errors with `next(err)`. Never throw inside an async callback.
* Express 5 forwards rejected promises from handlers to the error handler. **Express 4 does not.** Wrap async middleware: `(req,res,next) => { p(req,res).then(() => next(), next) }`.
* An error handler has 4 args `(err, req, res, next)` and goes last. If `res.headersSent`, delegate to `next(err)`.
* Express 5 differences: `req.body` is `undefined` without a parser (it was `{}` in 4); `req.query` is a getter, so don't assign to it; path syntax follows path-to-regexp v8 (`/*splat`, no inline regex); `res.status()` validates codes.
* Don't mutate `req`/`res` beyond a namespaced property (`res.locals.bfe`). Don't set headers once `headersSent`.

## Trust proxy & client IP (BFE-006)
* `app.set("trust proxy", v)` controls `req.ip`, `req.ips`, `req.protocol`, `req.secure` and `req.hostname`.
* Values: `false` (default: socket address), `true` (trust **every** hop, so any client can spoof `X-Forwarded-For`), a hop count `1`, IPs/CIDRs or `"loopback"`, `"uniquelocal"`, or a function.
* **Unsafe:** `true` on an internet-facing app, or a hop count higher than the real proxy chain. **Safe:** the exact hop count, or the proxy's subnet.
* Behind an HTTPS-terminating proxy without trust proxy, `req.secure` is false, so `Secure` cookies and HSTS logic break.
* The library uses `req.ip` and never parses `X-Forwarded-For` itself.

## Body limits (BFE-003)
`express.json()` and `express.urlencoded()` default to `limit: "100kb"`; urlencoded has `parameterLimit` 1000. Raise limits per route, not globally. A missing parser for a route means there's nothing to limit there (not a fail). A limit set in an unseen proxy (Nginx `client_max_body_size`) means `not_assessed`, not fail.

## Security headers (BFE-001)
The recommended set, usually via `helmet` or a proxy:
`Content-Security-Policy`, `Strict-Transport-Security` (HTTPS only), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` or CSP `frame-ancestors`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and `Permissions-Policy` where relevant.
`app.disable("x-powered-by")`. `X-XSS-Protection` is obsolete: set it to `0` or omit it, never recommend enabling it. JSON-only APIs need fewer headers than HTML apps; say so in remediation text.

## CORS (BFE-002)
Dangerous: reflecting any `Origin` with `credentials: true`; `origin: "*"` on authenticated/sensitive routes; regexes like `/example\.com/` (unanchored, matches `evil-example.com`). Safe: an explicit allowlist of exact origins. Browsers reject `*` together with credentials.

## Cookies & sessions (BFE-008)
`HttpOnly`, `Secure` (requires trust proxy when behind a TLS proxy), `SameSite=Lax|Strict` (`None` requires `Secure`), a narrow `Path`/`Domain`, and the `__Host-` prefix where possible. express-session: a non-default `name`, a secret from the environment (never a literal), the `cookie.secure` and `proxy` options, and a production store (MemoryStore leaks memory and is single-instance).

## Errors in production (BFE-007)
Express's default handler hides stack traces when `NODE_ENV=production`. Custom handlers that send `err.stack`/`err.message` are findings. Unknown `NODE_ENV` means `not_assessed`.

## Rate limiting
* Algorithms: fixed window (simple, allows bursts at the boundary), sliding-window counter (recommended default), token bucket (smooth bursts). Document which one you use.
* Store interface (no client library dependency):
  ```ts
  interface RateLimitStore { hit(key: string, windowMs: number, now: number): Promise<{ count: number; resetAt: number }>; reset?(key: string): Promise<void> }
  ```
  The in-memory store is the single-instance default, with bounded size and periodic eviction. The Redis-compatible store accepts any client exposing `eval`/`evalsha`, does the increment+expire **atomically** in one Lua script, and namespaces keys (`bfe:rl:<id>:<key>`).
* Keys: `req.ip` (group IPv6 to /64), or a custom `keyGenerator`. Login limits key on IP plus username (hashed, never stored raw).
* Responses: status `429`, a `Retry-After` header, and optional IETF `RateLimit-Policy`/`RateLimit` headers. The body has no internal details.
* **Store down:** the `onStoreError: "fail-open" | "fail-closed"` option. Every store call has a timeout (e.g. 100 ms), and errors go to the injected logger, rate-limited. Document the default (fail-open for general traffic; recommend fail-closed for login).
* Multi-instance correctness only holds with a shared store. Test it: two app instances sharing one store must share the count.

## Audit logger
* Capture on `res.on("finish")` (and `"close"` for aborted requests): method, route pattern (not the raw URL with query), status, duration, `req.ip`, request ID.
* Redact **before** the sink: headers `authorization`, `cookie`, `set-cookie`, `x-api-key`, `proxy-authorization`, plus configured body paths (case-insensitive keys, arrays, nested). Don't log bodies by default.
* The sink is async and non-blocking with a bounded queue. On overflow, drop and count. A sink failure never affects the response.

## Supertest patterns
```ts
const res = await request(app).get("/x").set("X-Forwarded-For", "1.2.3.4").expect(200);
```
Test: header presence and absence, spoofed XFF with each trust-proxy setting, oversized bodies → 413, 429 after N hits, store outage under both modes, error-handler output with `NODE_ENV=production`, Express 4 and 5.
