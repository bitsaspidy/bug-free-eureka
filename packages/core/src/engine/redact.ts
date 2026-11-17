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
  /** Total characters of text scanned before strings become "[Truncated]". Default 200000. */
  maxChars?: number;
  /** Extra key names to treat as sensitive (compared after normalization). */
  extraKeys?: readonly string[];
}

// Three checks, any one is enough (over-redaction is accepted on purpose):
// 1. the normalized key (lower-case, no "-", "_", "." or spaces) is an exact name;
// 2. the normalized key contains a long, unambiguous part;
// 3. one of its words (split on separators and camelCase) is a short secret word.
const EXACT_KEYS: readonly string[] = ["code", "ssn", "cvv", "cvc", "connectsid"];
const KEY_PARTS: readonly string[] = [
  "password",
  "passphrase",
  "passcode",
  "passwd",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "privkey",
  "privatekey",
  "authorization",
  "cookie",
  "credential",
  "onetimecode",
  "verificationcode",
  "otpcode",
  "mfacode",
  "sessionid",
  "signature",
  "bearer",
];
const KEY_WORDS: readonly string[] = [
  "auth",
  "otp",
  "totp",
  "hotp",
  "mfa",
  "pass",
  "pwd",
  "pin",
  "cred",
  "creds",
  "session",
  "sid",
  "jwt",
];

export function normalizeKey(key: string): string {
  let out = "";
  const capped = key.length > 200 ? key.slice(0, 200) : key;
  for (const ch of capped.toLowerCase()) {
    if (ch !== "-" && ch !== "_" && ch !== "." && ch !== " ") out += ch;
  }
  return out;
}

/** Splits `dbPass`, `X-OTP`, `XAuthToken` into lower-case words. Linear, capped input. */
function keyWords(key: string): string[] {
  const capped = key.length > 200 ? key.slice(0, 200) : key;
  const words: string[] = [];
  let cur = "";
  for (let i = 0; i < capped.length; i++) {
    const ch = capped[i] as string;
    const isUpper = ch >= "A" && ch <= "Z";
    const isAlnum = isUpper || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (!isAlnum) {
      if (cur) words.push(cur);
      cur = "";
      continue;
    }
    const prev = capped[i - 1] ?? "";
    const next = capped[i + 1] ?? "";
    const prevLower = (prev >= "a" && prev <= "z") || (prev >= "0" && prev <= "9");
    const prevUpper = prev >= "A" && prev <= "Z";
    const nextLower = next >= "a" && next <= "z";
    if (isUpper && cur && (prevLower || (prevUpper && nextLower))) {
      words.push(cur);
      cur = "";
    }
    cur += ch.toLowerCase();
  }
  if (cur) words.push(cur);
  return words;
}

/** True when a value stored under this key must never be output. */
export function isSensitiveKey(key: string, extraKeys: readonly string[] = []): boolean {
  const k = normalizeKey(key);
  if (EXACT_KEYS.includes(k)) return true;
  if (KEY_PARTS.some((part) => k.includes(part))) return true;
  if (keyWords(key).some((w) => KEY_WORDS.includes(w))) return true;
  return extraKeys.some((extra) => normalizeKey(extra) === k);
}

interface State {
  nodes: number;
  chars: number;
  readonly maxChars: number;
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
function ownData(obj: object, limit = Number.POSITIVE_INFINITY): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    if (n++ >= limit) {
      out["[Truncated]"] = "[Truncated]";
      break;
    }
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    out[key] = desc && "value" in desc ? desc.value : "[Getter]";
  }
  return out;
}

/** Map keys as text without calling user code (no toString on objects). */
function keyText(k: unknown): string {
  if (typeof k === "string") return k;
  if (typeof k === "symbol") return k.description ?? "";
  if (k !== null && (typeof k === "object" || typeof k === "function")) return "[object]";
  return String(k);
}

function walk(value: unknown, depth: number, state: State): unknown {
  state.nodes += 1;
  if (state.nodes > state.maxNodes) return "[Truncated]";
  if (typeof value === "string") {
    // Total text scanned is bounded too, so many large strings cannot stall a log call.
    if (state.chars >= state.maxChars) return "[Truncated]";
    state.chars += Math.min(value.length, 10_000);
    return maskSecrets(value);
  }
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
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        if (state.nodes >= state.maxNodes) {
          out.push("[Truncated]");
          break;
        }
        // Index accessors are never invoked.
        const desc = Object.getOwnPropertyDescriptor(value, i);
        out.push(desc && !("value" in desc) ? "[Getter]" : walk(desc?.value, depth + 1, state));
      }
      return out;
    }
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value) {
        if (state.nodes >= state.maxNodes) {
          out["[Truncated]"] = "[Truncated]";
          break;
        }
        const name = keyText(k);
        out[maskSecrets(name)] = isSensitiveKey(name, state.extraKeys)
          ? MASK
          : walk(v, depth + 1, state);
      }
      return out;
    }
    if (value instanceof Set) {
      const out: unknown[] = [];
      for (const v of value) {
        if (state.nodes >= state.maxNodes) {
          out.push("[Truncated]");
          break;
        }
        out.push(walk(v, depth + 1, state));
      }
      return out;
    }
    if (value instanceof Date)
      return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(ownData(value, state.maxNodes - state.nodes))) {
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
    chars: 0,
    maxChars: Math.max(1, Math.floor(options.maxChars ?? 200_000)),
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
  for (const [k, v] of Object.entries(headers)) {
    // Check the original name: lower-casing first would hide camelCase words (dbPass).
    lowered[k.toLowerCase()] = isSensitiveKey(k, options.extraKeys) ? MASK : v;
  }
  const out = redact(lowered, options);
  return out !== null && typeof out === "object" && !Array.isArray(out)
    ? (out as Record<string, unknown>)
    : {};
}
