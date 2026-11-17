---
"@bug-free-eureka/express": minor
---

Add the Express 4/5 adapter: `createRateLimiter` (sliding-window counter keyed on `req.ip` with IPv6 /64 grouping, hashed keys, `fail-open`/`fail-closed` store-outage modes with a per-call timeout), `createMemoryStore` (bounded) and `createRedisStore` (client-agnostic, atomic Lua script, no Redis dependency), and `createAuditLogger` (redacts through core's `redact`/`redactHeaders`; headers, query and body are opt-in). Express is a peer dependency (`^4.21.0 || ^5.0.0`).
