export const MASK = "****";

/** Masking helper: never reveals any part (or the length) of the value. */
export function mask(value?: unknown): string {
  void value; // intentionally ignored: nothing about the value may leak
  return MASK;
}

const MAX_SCAN_LENGTH = 10_000;
const KEY =
  "(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|authorization|auth|session(?:id)?|otp|credential|private[_-]?key)";

// Every pattern is linear-time: bounded quantifiers, no nested/overlapping repeats,
// and input is capped to MAX_SCAN_LENGTH before matching. No unbounded leading
// prefix is matched (keys such as X_DATABASE_PASSWORD match on the KEY part).
const VALUE = [
  String.raw`"(?:[^"\\]|\\.){0,2000}"`, // "quoted value, may contain spaces and \" escapes"
  String.raw`'(?:[^'\\]|\\.){0,2000}'`,
  String.raw`\\"(?:[^\\]|\\[^"]){0,2000}\\"`, // JSON embedded in a string: \"value\"
  String.raw`[^\s,;&"'\\]{1,2000}`, // unquoted (includes URL-encoded %xx)
  String.raw`\\?["'][^\r\n]{0,2000}`, // unterminated quote: mask to end of line
].join("|");

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  // Private key blocks: everything from BEGIN to END (or to end of input if unterminated).
  [
    /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g,
    MASK,
  ],
  // Credentials embedded in URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]{0,200}:[^\s/@]{1,500}@/gi, `$1${MASK}@`],
  // Whole cookie header lines (every cookie after the first too).
  [/(cookie\s{0,3}[:=]\s{0,3})[^\r\n]{1,4000}/gi, `$1${MASK}`],
  [/\b(Bearer|Basic)\s{1,5}[A-Za-z0-9._~+/=-]{4,2000}/gi, `$1 ${MASK}`],
  // key=value, key: value, "key":"value", \"key\":\"value\"
  [
    new RegExp(String.raw`(${KEY}[\w.-]{0,200}\\?["']?\s{0,3}[:=]\s{0,3})(?:${VALUE})`, "gi"),
    `$1${MASK}`,
  ],
  [/\beyJ[A-Za-z0-9_-]{5,2000}\.[A-Za-z0-9_-]{5,2000}\.[A-Za-z0-9_-]{0,2000}/g, MASK],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|xox[a-z])[-_][A-Za-z0-9_-]{16,200}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
];

/**
 * Defense in depth: masks secret-looking substrings in free text. Rules must
 * still never put secret values in evidence; this is the safety net.
 */
export function maskSecrets(text: string): string {
  let out = text.length > MAX_SCAN_LENGTH ? `${text.slice(0, MAX_SCAN_LENGTH)}...` : text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
