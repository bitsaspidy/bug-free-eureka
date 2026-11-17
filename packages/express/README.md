# @bug-free-eureka/express

Opt-in Express middleware for Bug-Free Eureka: a rate limiter and a redacting audit logger. Not yet published to npm.

- Express `^4.21.0 || ^5.0.0` is a **peer dependency**; tested on Express 4 and 5.
- Nothing is enabled by default. Each middleware changes only what is documented below. Neither one changes `trust proxy`, body parsers, headers or other middleware.

## Rate limiter

```js
import express from "express";
import { createRateLimiter } from "@bug-free-eureka/express";

const app = express();
app.set("trust proxy", 1); // the exact number of proxies in front of the app
app.use(createRateLimiter({ limit: 100, windowMs: 60_000 }));
app.use("/login", createRateLimiter({ name: "login", limit: 5, onStoreError: "fail-closed" }));
```

| Option | Default | Meaning |
|---|---|---|
| `windowMs` | `60000` | Window length (1 s to 24 h). |
| `limit` | `100` | Requests per window and key. |
| `store` | new in-memory store | Where counts live. |
| `onStoreError` | `"fail-open"` | `"fail-open"`: let requests through when the store fails. `"fail-closed"`: answer `503`. |
| `storeTimeoutMs` | `100` | A store call slower than this counts as a failure. |
| `keyGenerator` | `req.ip` | Custom key, for example IP plus normalised username for login. |
| `skip` | none | Return `true` to skip a request (e.g. health checks). |
| `standardHeaders` | `false` | Send IETF `RateLimit-Policy` / `RateLimit` headers. |
| `message` | `"Too Many Requests"` | Plain-text body of the 429 response. |
| `logger` | none | Gets `store_error` and `trust_proxy_true` events (at most one per type per minute). |
| `name` | `"default"` | Policy name; also separates the keys of different limiters. |

Invalid options throw `RateLimitOptionsError` when the middleware is created.

**Algorithm:** sliding-window counter. The previous fixed window's count is weighted by how much of it still overlaps the sliding window. Rejected requests are counted too, so a client that keeps hammering stays limited.

**Over the limit:** `429` with `Retry-After` (seconds) and no internal details.

**Client identity:** the default key is `req.ip`. IPv6 addresses are grouped to their /64 network and IPv4-mapped IPv6 addresses become IPv4. The limiter never reads `X-Forwarded-For` itself, so a forged header only matters if your `trust proxy` setting trusts it. With `trust proxy: true`, every client can choose its own `req.ip` and bypass the limiter, and the `logger` receives a `trust_proxy_true` warning. Keys are SHA-256 hashed before they reach any store, so stores never hold raw IPs or usernames.

### Stores

**In-memory** (`createMemoryStore({ maxKeys })`, default 100 000 keys) works for a single process only. When it is full, it evicts expired keys first, then the least recently updated ones. An attacker who sends from many addresses can push other clients' counters out early. Use a shared store for more than one instance.

**Redis-compatible** (`createRedisStore({ eval, prefix })`) is shared by every instance that uses the same server and prefix (`bfe:rl:` by default). The package bundles no Redis client: you pass a function that runs `EVAL`:

```js
// ioredis
createRedisStore({ eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args) });
// node-redis v4/v5
createRedisStore({ eval: (script, keys, args) => client.eval(script, { keys, arguments: args }) });
```

Increment and expiry run atomically in one Lua script. Window boundaries come from each instance's clock, so keep the clocks in sync (NTP).

### When the store is down

| `onStoreError` | Store error or timeout | Use for |
|---|---|---|
| `"fail-open"` (default) | The request passes without being counted. | General traffic, where availability matters more. |
| `"fail-closed"` | `503 Service Unavailable` with `Retry-After: 1`. | Login, OTP, password reset and other brute-force targets. |

Both modes report a `store_error` event to `logger`, rate-limited, with secrets masked.

## Audit logger

```js
import { createAuditLogger } from "@bug-free-eureka/express";

app.use(createAuditLogger({ sink: (event) => logger.info(event) }));
```

On `finish` (or `close` for aborted requests) the sink gets one event: `time`, `requestId` (from a safe `X-Request-ID`, otherwise a random UUID), `method`, `route` (the matched pattern such as `/users/:id`, never the raw URL or query), `status`, `durationMs`, `ip` (`req.ip`) and `aborted`.

| Option | Default | Meaning |
|---|---|---|
| `headers` | `[]` | Request headers to include (allowlist). |
| `query` | `false` | Include `req.query`. |
| `body` | `false` | Include `req.body`. |
| `sensitiveKeys` | `[]` | Extra key or header names to mask. |
| `maxQueue` | `1000` | Events waiting for the sink. Extra events are dropped and counted. |

Headers, query and body pass through core's `redactHeaders` / `redact`. Values under sensitive names (`authorization`, `cookie`, `x-api-key`, `password`, `otp`, `refreshToken` and similar) become `****`, and secret-looking strings elsewhere are masked. Redaction works by **name**: a custom header or field that holds a secret under a name that doesn't look sensitive (for example `x-refresh`) must be added to `sensitiveKeys`.

The sink runs after the response, one event at a time. A sink that throws or rejects never affects the response. `logger.stats()` returns `{ dropped, failed, queued }`, and `await logger.flush()` waits for the queue to empty.

## Not included yet

Security-header and other hardening middleware is planned but not built.
