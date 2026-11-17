/**
 * Rate-limit stores. The limiter uses the sliding-window counter algorithm:
 * each store keeps a counter for the current fixed window and returns the
 * previous window's count, and the limiter weights the previous count by how
 * much of it still overlaps the sliding window.
 */

export interface RateLimitHit {
  /** Hits in the current fixed window, including this one. */
  current: number;
  /** Hits in the previous fixed window. */
  previous: number;
}

export interface RateLimitStore {
  /**
   * Atomically records one hit for `key` in the fixed window that contains
   * `now` and returns the counts. `key` is already hashed by the limiter.
   */
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
  /** Forgets a key (both windows). Optional. */
  reset?(key: string, windowMs: number, now: number): Promise<void>;
}

export interface MemoryStoreOptions {
  /** Upper bound on tracked keys. Default 100000. */
  maxKeys?: number;
}

interface Entry {
  window: number;
  current: number;
  previous: number;
}

export interface MemoryStore extends RateLimitStore {
  /** Number of tracked keys (for tests and monitoring). */
  size(): number;
}

/**
 * Single-process store. Counts are not shared between processes or hosts:
 * for more than one instance use a shared store such as `createRedisStore`.
 * Bounded: when `maxKeys` is reached, the least recently updated 10% of keys
 * are evicted. A flood of new keys can therefore reset older counters: use a
 * shared store for login and other brute-force targets. No timers are started.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const maxKeys = Math.max(1, Math.floor(options.maxKeys ?? 100_000));
  const map = new Map<string, Entry>();

  // Map iteration order is least recently updated first (hit() re-inserts).
  // Evicting a 10% batch from the front keeps the cost amortized O(1) per new
  // key, with no full scan, even when every tracked key is still active.
  const batch = Math.max(1, Math.ceil(maxKeys / 10));
  function evict(): void {
    const it = map.keys();
    for (let i = 0; i < batch; i++) {
      const next = it.next();
      if (next.done) break;
      map.delete(next.value);
    }
  }

  return {
    hit(key, windowMs, now) {
      const window = Math.floor(now / windowMs);
      let e = map.get(key);
      if (e) {
        map.delete(key); // re-insert to mark as recently used
        if (e.window !== window) {
          e = {
            window,
            current: 0,
            previous: e.window === window - 1 ? e.current : 0,
          };
        }
      } else {
        if (map.size >= maxKeys) evict();
        e = { window, current: 0, previous: 0 };
      }
      e.current += 1;
      map.set(key, e);
      return Promise.resolve({ current: e.current, previous: e.previous });
    },
    reset(key) {
      map.delete(key);
      return Promise.resolve();
    },
    size() {
      return map.size;
    },
  };
}

/**
 * Runs a Lua script on Redis (or a Redis-compatible server). Adapt your client:
 *
 * - ioredis: `(script, keys, args) => client.eval(script, keys.length, ...keys, ...args)`
 * - node-redis v4/v5: `(script, keys, args) => client.eval(script, { keys, arguments: args })`
 */
export type RedisEval = (script: string, keys: string[], args: string[]) => Promise<unknown>;

export interface RedisStoreOptions {
  /** Executes EVAL on your Redis client. No Redis client is bundled. */
  eval: RedisEval;
  /** Key namespace. Default "bfe:rl:". */
  prefix?: string;
}

/**
 * KEYS[1] = current window counter, KEYS[2] = previous window counter,
 * ARGV[1] = TTL in ms (two windows). INCR and PEXPIRE run atomically.
 */
export const REDIS_HIT_SCRIPT = [
  "local c = redis.call('INCR', KEYS[1])",
  "if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
  "local p = tonumber(redis.call('GET', KEYS[2]) or '0')",
  "return {c, p}",
].join("\n");

export const REDIS_RESET_SCRIPT = "return redis.call('DEL', KEYS[1], KEYS[2])";

export class RedisStoreReplyError extends Error {
  readonly code = "BFE_REDIS_REPLY";
  constructor() {
    super("Unexpected reply from the Redis eval function: expected an array of two integers.");
    this.name = "RedisStoreReplyError";
  }
}

function toCount(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) throw new RedisStoreReplyError();
  return n;
}

/**
 * Shared store for multi-instance deployments. All instances that use the
 * same Redis and prefix share the counts. Window boundaries come from each
 * instance's clock (`now`), so keep instance clocks in sync (NTP).
 */
export function createRedisStore(options: RedisStoreOptions): RateLimitStore {
  if (typeof options?.eval !== "function") {
    throw new TypeError("createRedisStore: `eval` must be a function (see RedisEval docs).");
  }
  const run = options.eval;
  const prefix = options.prefix ?? "bfe:rl:";
  const keys = (key: string, windowMs: number, now: number): [string, string] => {
    const w = Math.floor(now / windowMs);
    return [`${prefix}${windowMs}:${key}:${w}`, `${prefix}${windowMs}:${key}:${w - 1}`];
  };
  return {
    async hit(key, windowMs, now) {
      const reply = await run(REDIS_HIT_SCRIPT, keys(key, windowMs, now), [String(2 * windowMs)]);
      if (!Array.isArray(reply) || reply.length !== 2) throw new RedisStoreReplyError();
      return { current: toCount(reply[0]), previous: toCount(reply[1]) };
    },
    async reset(key, windowMs, now) {
      await run(REDIS_RESET_SCRIPT, keys(key, windowMs, now), []);
    },
  };
}
