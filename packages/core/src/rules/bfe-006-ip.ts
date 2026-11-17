// Strict IPv4 / IPv6 / CIDR parsing for BFE-006. Hand-written scanners over
// already-capped strings (<= 100 chars): no regular expressions, so no
// backtracking risk. Matches proxy-addr behaviour, including IPv4-mapped IPv6.

export interface IpRange {
  family: 4 | 6;
  /** 4 or 16 bytes. */
  bytes: readonly number[];
  prefix: number;
}

export type ListClass = "invalid" | "trust-all" | "very-broad" | "private-wide" | "specific";

interface ParsedEntry {
  ranges: IpRange[];
  /** true for the names loopback, linklocal, uniquelocal. */
  named: boolean;
  uniquelocal: boolean;
}

function decimal(part: string, maxLength: number): number | undefined {
  if (part.length === 0 || part.length > maxLength) return undefined;
  if (part.length > 1 && part.startsWith("0")) return undefined; // no octal-looking forms
  let n = 0;
  for (let i = 0; i < part.length; i++) {
    const c = part.charCodeAt(i);
    if (c < 48 || c > 57) return undefined;
    n = n * 10 + (c - 48);
  }
  return n;
}

function hexGroup(part: string): number | undefined {
  if (part.length === 0 || part.length > 4) return undefined;
  let n = 0;
  for (let i = 0; i < part.length; i++) {
    const c = part.charCodeAt(i);
    let d: number;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 102) d = c - 87;
    else if (c >= 65 && c <= 70) d = c - 55;
    else return undefined;
    n = n * 16 + d;
  }
  return n;
}

export function parseIPv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const part of parts) {
    const n = decimal(part, 3);
    if (n === undefined || n > 255) return undefined;
    out.push(n);
  }
  return out;
}

function groupsOf(text: string, allowV4Tail: boolean): number[] | undefined {
  if (text === "") return [];
  const parts = text.split(":");
  const out: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (allowV4Tail && i === parts.length - 1 && part.includes(".")) {
      const v4 = parseIPv4(part);
      if (v4 === undefined) return undefined;
      out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
    } else {
      const g = hexGroup(part);
      if (g === undefined) return undefined;
      out.push(g);
    }
  }
  return out;
}

export function parseIPv6(text: string): number[] | undefined {
  const gap = text.indexOf("::");
  if (gap !== -1 && text.indexOf("::", gap + 1) !== -1) return undefined; // ":::" or two gaps
  const head = groupsOf(gap === -1 ? text : text.slice(0, gap), gap === -1);
  const tail = gap === -1 ? [] : groupsOf(text.slice(gap + 2), true);
  if (head === undefined || tail === undefined) return undefined;
  let groups: number[];
  if (gap === -1) {
    if (head.length !== 8) return undefined;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return undefined;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  }
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 255);
  return bytes;
}

function isMapped(bytes: readonly number[]): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 255 && bytes[11] === 255;
}

function parseAddress(text: string): { family: 4 | 6; bytes: number[] } | undefined {
  if (text.includes(":")) {
    const bytes = parseIPv6(text);
    return bytes === undefined ? undefined : { family: 6, bytes };
  }
  const bytes = parseIPv4(text);
  return bytes === undefined ? undefined : { family: 4, bytes };
}

/** Prefix length of a contiguous netmask, or undefined when it is not one. */
function netmaskPrefix(bytes: readonly number[]): number | undefined {
  let ones = 0;
  let seenZero = false;
  for (const b of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      if (((b >> bit) & 1) === 1) {
        if (seenZero) return undefined;
        ones++;
      } else {
        seenZero = true;
      }
    }
  }
  return ones;
}

const r4 = (bytes: number[], prefix: number): IpRange => ({ family: 4, bytes, prefix });
const r6 = (head: number[], prefix: number): IpRange => ({
  family: 6,
  bytes: [...head, ...new Array<number>(16 - head.length).fill(0)],
  prefix,
});

const LOOPBACK: readonly IpRange[] = [
  r4([127, 0, 0, 0], 8),
  { family: 6, bytes: [...new Array<number>(15).fill(0), 1], prefix: 128 },
];
const LINKLOCAL: readonly IpRange[] = [r4([169, 254, 0, 0], 16), r6([0xfe, 0x80], 10)];
const UNIQUELOCAL: readonly IpRange[] = [
  r4([10, 0, 0, 0], 8),
  r4([172, 16, 0, 0], 12),
  r4([192, 168, 0, 0], 16),
  r6([0xfc], 7),
];

function prefixEqual(a: readonly number[], b: readonly number[], prefix: number): boolean {
  const whole = Math.floor(prefix / 8);
  for (let i = 0; i < whole; i++) if (a[i] !== b[i]) return false;
  const rest = prefix % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((a[whole] ?? 0) & mask) === ((b[whole] ?? 0) & mask);
}

/** true when `inner` lies completely inside `outer`. */
export function contains(outer: IpRange, inner: IpRange): boolean {
  return (
    outer.family === inner.family &&
    outer.prefix <= inner.prefix &&
    prefixEqual(outer.bytes, inner.bytes, outer.prefix)
  );
}

const MAPPED_V4_SPACE: IpRange = {
  family: 6,
  bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0],
  prefix: 96,
};

const isPrivate = (range: IpRange): boolean => UNIQUELOCAL.some((block) => contains(block, range));

/** Parses one entry: an address, addr/prefix, addr/netmask, or a lower-case name. */
export function parseEntry(raw: string): ParsedEntry | undefined {
  if (raw === "loopback") return { ranges: [...LOOPBACK], named: true, uniquelocal: false };
  if (raw === "linklocal") return { ranges: [...LINKLOCAL], named: true, uniquelocal: false };
  if (raw === "uniquelocal") return { ranges: [...UNIQUELOCAL], named: true, uniquelocal: true };

  const slash = raw.indexOf("/");
  if (slash !== -1 && raw.indexOf("/", slash + 1) !== -1) return undefined;
  const address = parseAddress(slash === -1 ? raw : raw.slice(0, slash));
  if (address === undefined) return undefined;
  const max = address.family === 4 ? 32 : 128;

  let prefix = max;
  if (slash !== -1) {
    const suffix = raw.slice(slash + 1);
    if (suffix.includes(".") || suffix.includes(":")) {
      const mask = parseAddress(suffix);
      if (mask === undefined || mask.family !== address.family) return undefined;
      const p = netmaskPrefix(mask.bytes);
      if (p === undefined) return undefined;
      prefix = p;
    } else {
      const p = decimal(suffix, 3);
      if (p === undefined || p > max) return undefined;
      prefix = p;
    }
  }

  const range: IpRange =
    address.family === 6 && isMapped(address.bytes) && prefix >= 96
      ? { family: 4, bytes: address.bytes.slice(12), prefix: prefix - 96 }
      : { family: address.family, bytes: address.bytes, prefix };
  return { ranges: [range], named: false, uniquelocal: false };
}

export interface ListClassification {
  cls: ListClass;
  ranges: IpRange[];
}

/** Classifies a trusted-entry list as a set (order and duplicates do not matter). */
export function classifyList(entries: readonly string[]): ListClassification {
  const ranges: IpRange[] = [];
  let trustAll = false;
  let veryBroad = false;
  let privateWide = false;
  for (const raw of new Set(entries)) {
    const parsed = parseEntry(raw);
    if (parsed === undefined) return { cls: "invalid", ranges: [] };
    ranges.push(...parsed.ranges);
    if (parsed.uniquelocal) privateWide = true;
    if (parsed.named) continue;
    for (const range of parsed.ranges) {
      // An IPv6 range containing ::ffff:0:0/96 also trusts every IPv4-mapped peer.
      if (range.prefix === 0 || contains(range, MAPPED_V4_SPACE)) trustAll = true;
      else if (range.prefix < (range.family === 4 ? 16 : 48)) {
        if (isPrivate(range)) privateWide = true;
        else veryBroad = true;
      }
    }
  }
  const cls: ListClass = trustAll
    ? "trust-all"
    : veryBroad
      ? "very-broad"
      : privateWide
        ? "private-wide"
        : "specific";
  return { cls, ranges };
}

/** Counts declared proxy addresses that no trusted range covers, and those that do not parse. */
export function proxyCoverage(
  trusted: readonly IpRange[],
  proxyAddresses: readonly string[],
): { uncovered: number; invalid: number } {
  let uncovered = 0;
  let invalid = 0;
  for (const raw of new Set(proxyAddresses)) {
    const parsed = parseEntry(raw);
    if (parsed === undefined || parsed.named) {
      invalid++;
      continue;
    }
    const declared = parsed.ranges[0];
    if (declared === undefined || !trusted.some((t) => contains(t, declared))) uncovered++;
  }
  return { uncovered, invalid };
}
