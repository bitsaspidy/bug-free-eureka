import express5 from "express";
import express4 from "express4";
import { REDIS_HIT_SCRIPT, REDIS_RESET_SCRIPT, type RedisEval } from "../src/index.js";

type ExpressFactory = typeof express5;

/** Both supported Express majors; tests run once per entry. */
export const EXPRESS_VERSIONS: [string, ExpressFactory][] = [
  ["express 5", express5],
  ["express 4", express4 as unknown as ExpressFactory],
];

/**
 * In-memory stand-in for a Redis server: understands only our two Lua
 * scripts. Many stores (app instances) can share one FakeRedis. It can be
 * switched "down" (every call rejects) or made slow.
 */
export class FakeRedis {
  readonly data = new Map<string, number>();
  down = false;
  delayMs = 0;
  calls = 0;

  readonly eval: RedisEval = async (script, keys, args) => {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.down) throw new Error("connect ECONNREFUSED 10.0.0.5:6379");
    if (script === REDIS_HIT_SCRIPT) {
      const [cur = "", prev = ""] = keys;
      void args; // TTL is not modelled; window keys differ per window.
      const c = (this.data.get(cur) ?? 0) + 1;
      this.data.set(cur, c);
      return [c, this.data.get(prev) ?? 0];
    }
    if (script === REDIS_RESET_SCRIPT) {
      for (const k of keys) this.data.delete(k);
      return keys.length;
    }
    throw new Error("NOSCRIPT unknown script");
  };
}

/** Starts on a 60 s window boundary. */
export function manualClock(start = 1_699_999_980_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}
