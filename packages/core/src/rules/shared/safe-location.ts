// One allowlist for "file:line" locations that may appear in evidence.
// Hand-written scanner (no regex backtracking). Only a relative path of
// [A-Za-z0-9_.-] segments ending in a source or config extension is echoed.

const MAX_LENGTH = 200;
const EXTENSIONS: readonly string[] = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".json",
  ".conf",
];

function isSegmentChar(c: number): boolean {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95 ||
    c === 46 ||
    c === 45
  );
}

function isSafeSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  for (let i = 0; i < segment.length; i++) if (!isSegmentChar(segment.charCodeAt(i))) return false;
  return true;
}

/** Returns the location when it is a safe relative `path.ext:line`, otherwise undefined. */
export function safeLocation(location: string | undefined): string | undefined {
  if (location === undefined || location.length > MAX_LENGTH) return undefined;
  const colon = location.lastIndexOf(":");
  if (colon < 1) return undefined;
  const line = location.slice(colon + 1);
  if (line.length < 1 || line.length > 9) return undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) return undefined;
  }
  const path = location.slice(0, colon);
  if (!EXTENSIONS.some((ext) => path.endsWith(ext))) return undefined;
  return path.split("/").every(isSafeSegment) ? location : undefined;
}
