// Runnable example for docs/deployment.md (multi-instance rate limits).
// Tested with a fake ioredis client by tests/integration/docs-examples.test.ts.
import { createRedisStore } from "@bug-free-eureka/express";

// #region ioredis
// `redis` is an ioredis client, for example: new Redis(process.env.REDIS_URL)
export function createSharedStore(redis) {
  return createRedisStore({
    eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args),
    prefix: "bfe:rl:",
  });
}
// #endregion ioredis
