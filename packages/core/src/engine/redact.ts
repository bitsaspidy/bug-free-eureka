import { MASK, maskSecrets } from "./mask.js";

/**
 * Deep redaction for anything that may be logged, reported or thrown.
 * Values under sensitive keys are replaced with MASK; every other string goes
 * through maskSecrets. Bounded: depth, node count, cycles, getters and string
 * length cannot make it hang, throw or leak. The input is never mutated.
 */

export interface RedactOptions {
  /** Nesting depth before a subtree is replaced with "[MaxDepth]". Default 8. */
  maxDepth?: number;
  /** Total values visited before the rest is replaced with "[Truncated]". Default 2000. */
  maxNodes?: number;
  /** Extra key names to treat as sensitive (compared after normalization). */
  extraKeys?: readonly string[];
}

// Keys are compared after lower-casing and removing "-", "_", "." and spaces.
const EXACT_KEYS: readonly string[] = [
  "otp",
  "totp",
  "hotp",
  "mfacode",
  "pin",
  "sid",
  "connectsid",
  "session",
  "sessionid",
  "jwt",
  "pwd",
  "passwd",
  "pass",
  "ssn",
  "cvv",
  "cvc",
];
const KEY_PARTS: readonly string[] = [
  "password",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "privatekey",
  "onetimecode",
  "verificationcode",
  "signature",
];

export function normalizeKey(key: string): string {
  let out = "";
  const capped = key.length > 200 ? key.slice(0, 200) : key;
  for (const ch of capped.toLowerCase()) {
    if (ch !== "-" && ch !== "_" && ch !== "." && ch !== " ") out += ch;
  }
  return out;
}

/** True when a value stored under this key must never be output. */
export function isSensitiveKey(key: string, extraKeys: readonly string[] = []): boolean {
  const k = normalizeKey(key);
  if (EXACT_KEYS.includes(k)) return true;
  if (KEY_PARTS.some((part) => k.includes(part))) return true;
  return extraKeys.some((extra) => normalizeKey(extra) === k);
}

interface State {
  nodes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly extraKeys: readonly string[];
  readonly seen: WeakSet<object>;
}

function redactError(err: Error, depth: number, state: State): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: maskSecrets(String(err.name)),
    message: maskSecrets(String(err.message)),
  };
  // The stack repeats the message and may hold it unmasked elsewhere: mask it too.
  if (typeof err.stack === "string") out.stack = maskSecrets(err.stack);
  const own = walk({ ...ownData(err) }, depth, state);
  if (own !== null && typeof own === "object" && !Array.isArray(own)) Object.assign(out, own);
  return out;
}

/** Own enumerable data properties only: accessors are never invoked. */
function ownData(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    out[key] = desc && "value" in desc ? desc.value : "[Getter]";
  }
  return out;
}

function walk(value: unknown, depth: number, state: State): unknown {
  state.nodes += 1;
  if (state.nodes > state.maxNodes) return "[Truncated]";
  if (typeof value === "string") return maskSecrets(value);
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
    if (typeof value === "bigint") return value.toString();
    return value;
  }
  if (state.seen.has(value)) return "[Circular]";
  if (depth >= state.maxDepth) return "[MaxDepth]";
  state.seen.add(value);
  try {
    if (value instanceof Error) return redactError(value, depth + 1, state);
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, state));
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value) {
        const key = maskSecrets(String(k));
        out[key] =
          typeof k === "string" && isSensitiveKey(k, state.extraKeys)
            ? MASK
            : walk(v, depth + 1, state);
      }
      return out;
    }
    if (value instanceof Set) return [...value].map((v) => walk(v, depth + 1, state));
    if (value instanceof Date)
      return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(ownData(value))) {
      // Key names are masked as text too: a hostile key can carry a secret.
      out[maskSecrets(key)] = isSensitiveKey(key, state.extraKeys)
        ? MASK
        : walk(v, depth + 1, state);
    }
    return out;
  } finally {
    state.seen.delete(value);
  }
}

/**
 * Returns a redacted, JSON-safe copy of `value`. Never throws on hostile input
 * (cycles, getters that throw, deep nesting, huge strings).
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const state: State = {
    nodes: 0,
    maxNodes: Math.max(1, Math.floor(options.maxNodes ?? 2000)),
    maxDepth: Math.max(1, Math.floor(options.maxDepth ?? 8)),
    extraKeys: options.extraKeys ?? [],
    seen: new WeakSet(),
  };
  try {
    return walk(value, 0, state);
  } catch {
    // A Proxy trap or exotic object threw: output nothing from it.
    return "[Unredactable]";
  }
}

/** HTTP headers: names are lower-cased; sensitive values are masked. */
export function redactHeaders(
  headers: Readonly<Record<string, unknown>>,
  options: RedactOptions = {},
): Record<string, unknown> {
  const lowered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
  const out = redact(lowered, options);
  return out !== null && typeof out === "object" && !Array.isArray(out)
    ? (out as Record<string, unknown>)
    : {};
}
