import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bfe006,
  builtinRules,
  createRegistry,
  evaluateTrustedProxy,
  runRules,
  type TrustedProxyInput,
} from "../../src/index.js";
import { safeLocation } from "../../src/rules/shared/safe-location.js";
import { classifyList, parseEntry, parseIPv4, parseIPv6 } from "../../src/rules/bfe-006-ip.js";

const NOW = "2026-01-02T03:04:05.000Z";
const FIXTURE_DIR = new URL("../../../../tests/fixtures/rules/bfe-006/", import.meta.url);

interface Fixture {
  name: string;
  overrides: Record<string, unknown>;
  expected: { status: string; confidence: string };
}

const BASE: TrustedProxyInput = {
  app: { expressAppFound: true },
  deployment: {
    topology: "unknown",
    proxyAddresses: [],
    directExposure: "unknown",
    forwardedHeaderHandling: "unknown",
  },
  trustProxy: { state: "not_set" },
  coverage: { complete: true, limitsHit: [] },
};

function build(overrides: Record<string, unknown>): TrustedProxyInput {
  const out: Record<string, unknown> = { ...BASE };
  for (const [key, value] of Object.entries(overrides)) {
    const prev = out[key];
    // A replaced trustProxy block must not inherit a stale value from the base.
    out[key] =
      key !== "trustProxy" &&
      value !== null &&
      typeof value === "object" &&
      typeof prev === "object"
        ? { ...(prev as object), ...value }
        : value;
  }
  return out as unknown as TrustedProxyInput;
}

const withValue = (value: unknown, extra: Record<string, unknown> = {}): TrustedProxyInput =>
  build({ trustProxy: { state: "set", value, ...extra } });

const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, FIXTURE_DIR), "utf8")) as Fixture);

// Leak check, not an HTML filter: no canary value may appear in rule output, in any letter case
// (`<SCRIPT>`, `<script src=…>`). Case-insensitive so a case-changed echo still fails the test.
const CANARIES = /CANARY\d|10\.99\.88\.77|<script\b|etc\/passwd/i;

describe("BFE-006 spec fixtures", () => {
  it("loads every fixture (spec fixtures 33 and 34 are schema tests below)", () => {
    expect(fixtures).toHaveLength(36);
  });

  describe.each(fixtures)("$name", (fx) => {
    const input = build(fx.overrides);
    const result = evaluateTrustedProxy(input);

    it("returns the expected status and confidence", () => {
      expect({ status: result.status, confidence: result.confidence }).toEqual(fx.expected);
    });

    it("has evidence, no secrets, and is deterministic", () => {
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence.every((e) => e.detail.length > 0)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(CANARIES);
      expect(evaluateTrustedProxy(structuredClone(input))).toEqual(result);
    });
  });
});

describe("BFE-006 decision table details", () => {
  it("never fails on unknown or absent facts alone", () => {
    const unknownValues = [
      { kind: "boolean", value: true },
      { kind: "hops", hops: 5 },
      { kind: "list", entries: ["10.0.0.0/8"] },
      { kind: "function", alwaysTrue: true },
    ];
    for (const value of unknownValues) {
      for (const topology of ["unknown", "single-proxy", "cdn-plus-lb"]) {
        const r = evaluateTrustedProxy(
          build({ deployment: { topology }, trustProxy: { state: "set", value } }),
        );
        const hopsTooMany = value.kind === "hops" && topology !== "unknown";
        if (!hopsTooMany) expect(r.status).not.toBe("fail");
      }
    }
  });

  it("treats false and hops 0 as off", () => {
    const off = [
      withValue({ kind: "boolean", value: false }),
      withValue({ kind: "hops", hops: 0 }),
    ];
    for (const input of off) {
      expect(
        evaluateTrustedProxy({ ...input, deployment: { ...input.deployment, topology: "none" } })
          .status,
      ).toBe("pass");
    }
  });

  it("fails an always-true function with a declared proxy only when exposed", () => {
    const fn = { kind: "function", alwaysTrue: true };
    const exposed = build({
      deployment: { topology: "single-proxy", directExposure: "yes" },
      trustProxy: { state: "set", value: fn },
    });
    expect(evaluateTrustedProxy(exposed).status).toBe("fail");
  });

  it("uses declared hops over the topology default", () => {
    const input = build({
      deployment: { topology: "cdn-plus-lb", declaredHops: 3, directExposure: "no" },
      trustProxy: { state: "set", value: { kind: "hops", hops: 3 } },
    });
    expect(evaluateTrustedProxy(input)).toMatchObject({ status: "pass", confidence: "medium" });
  });

  it("warns when a declared proxy is not trusted (T12) and reports only counts", () => {
    const input = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["10.0.1.5", "10.0.2.9"] },
      trustProxy: { state: "set", value: { kind: "list", entries: ["10.0.1.5"] } },
    });
    const r = evaluateTrustedProxy(input);
    expect(r.status).toBe("warning");
    const text = JSON.stringify(r);
    expect(text).toContain("1 not covered");
    expect(text).not.toContain("10.0.1.5");
  });

  it("gives not_assessed when a declared proxy address cannot be parsed", () => {
    const input = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["not-an-ip"] },
      trustProxy: { state: "set", value: { kind: "list", entries: ["10.0.1.5"] } },
    });
    expect(evaluateTrustedProxy(input).status).toBe("not_assessed");
  });

  it("warns for very-broad public ranges and public CDN ranges stay specific", () => {
    const broad = build({
      deployment: { topology: "single-proxy" },
      trustProxy: { state: "set", value: { kind: "list", entries: ["64.0.0.0/4"] } },
    });
    expect(evaluateTrustedProxy(broad).status).toBe("warning");
    const cdn = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["173.245.48.0/20"] },
      trustProxy: { state: "set", value: { kind: "list", entries: ["173.245.48.0/20"] } },
    });
    expect(evaluateTrustedProxy(cdn).status).toBe("pass");
  });

  it("passes with a pass-evidence phrase that makes no security guarantee", () => {
    const r = evaluateTrustedProxy(build({ deployment: { topology: "none" } }));
    expect(r.status).toBe("pass");
    expect(JSON.stringify(r)).not.toMatch(/is secure|compliant|bug-free/i);
    expect(r.remediation).toContain("not a guarantee");
  });

  it("lists the Express properties that depend on the setting", () => {
    const r = evaluateTrustedProxy(build({}));
    expect(JSON.stringify(r.evidence)).toContain("req.ip, req.ips, req.protocol");
  });

  it("includes the safe location only when it matches file:line", () => {
    const good = evaluateTrustedProxy(
      withValue({ kind: "hops", hops: 1 }, { location: "src/app.ts:7" }),
    );
    expect(good.evidence.some((e) => e.location === "src/app.ts:7")).toBe(true);
    const bad = evaluateTrustedProxy(withValue({ kind: "hops", hops: 1 }, { location: "a b:1\n" }));
    expect(bad.evidence.some((e) => e.location === "unknown-location")).toBe(true);
  });

  it("returns neutral remediation per gate", () => {
    expect(evaluateTrustedProxy(build({ app: { expressAppFound: false } })).remediation).toMatch(
      /Non-Express/,
    );
    expect(
      evaluateTrustedProxy(build({ trustProxy: { state: "unresolved" } })).remediation,
    ).toMatch(/literal/);
    const warn = evaluateTrustedProxy(build({ deployment: { topology: "single-proxy" } }));
    expect(warn.remediation).toContain("Express:");
  });

  it("pluralises declared address and limit counts", () => {
    const one = evaluateTrustedProxy(
      build({
        deployment: { topology: "single-proxy", proxyAddresses: ["10.0.1.5"] },
        coverage: { complete: false, limitsHit: ["a"] },
      }),
    );
    expect(JSON.stringify(one.evidence)).toContain("1 declared proxy address");
    expect(JSON.stringify(one.evidence)).toContain("1 limit hit");
    const many = evaluateTrustedProxy(
      build({
        deployment: { topology: "single-proxy", proxyAddresses: ["10.0.1.5", "10.0.1.6"] },
        coverage: { complete: false, limitsHit: ["a", "b"] },
      }),
    );
    expect(JSON.stringify(many.evidence)).toContain("2 declared proxy addresses");
    expect(JSON.stringify(many.evidence)).toContain("2 limits hit");
  });
});

describe("BFE-006 metadata and engine integration", () => {
  it("is registered, sorted, and reports severity high for every status", () => {
    expect(builtinRules.map((r) => r.id)).toEqual([...builtinRules.map((r) => r.id)].sort());
    expect(builtinRules.map((r) => r.id)).toContain("BFE-006");
    expect(bfe006.defaultSeverity).toBe("high");
    expect(bfe006.references).toHaveLength(3);
    expect(bfe006.description).not.toMatch(/compliant|bug-free/i);
    const findings = runRules(
      createRegistry([bfe006]),
      build({ deployment: { topology: "none" } }),
      {
        now: NOW,
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "BFE-006", severity: "high", status: "pass" });
  });
});

describe("BFE-006 input schema and adversarial input", () => {
  const reject = (input: unknown): void => {
    const r = evaluateTrustedProxy(input);
    expect(r.status).toBe("not_assessed");
    expect(r.evidence[0]?.detail).toMatch(/^input invalid: /);
  };

  it("rejects input over the caps without truncating", () => {
    const entries65 = Array.from({ length: 65 }, () => "10.0.0.1");
    reject(withValue({ kind: "list", entries: entries65 }));
    reject(withValue({ kind: "list", entries: ["1".repeat(101)] }));
    reject(build({ deployment: { proxyAddresses: entries65 } }));
    reject(
      build({ coverage: { complete: true, limitsHit: Array.from({ length: 201 }, () => "x") } }),
    );
    reject(build({ coverage: { complete: true, limitsHit: ["x".repeat(501)] } }));
    reject(withValue({ kind: "list", entries: ["x".repeat(1_000_000)] }));
    reject(withValue({ kind: "boolean", value: true }, { location: "x".repeat(501) }));
  });

  it.each([1001, Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])("rejects hops %s", (hops) => {
    reject(withValue({ kind: "hops", hops }));
  });

  it("rejects numeric strings and a mismatching state/value pair", () => {
    reject(withValue({ kind: "hops", hops: "1" }));
    reject(build({ trustProxy: { state: "set" } }));
    reject(build({ trustProxy: { state: "unresolved", value: { kind: "boolean", value: true } } }));
  });

  it("rejects declaredHops without a declared proxy topology", () => {
    reject(build({ deployment: { topology: "none", declaredHops: 1 } }));
    reject(build({ deployment: { topology: "unknown", declaredHops: 1 } }));
    reject(build({ deployment: { topology: "single-proxy", declaredHops: 17 } }));
  });

  it("rejects non-object input, unknown keys and prototype-pollution keys", () => {
    reject(null);
    reject("CANARY9");
    reject({ ...BASE, extra: 1 });
    const polluted = JSON.parse(
      '{"__proto__":{"x":1},"constructor":{"y":2},"app":{"expressAppFound":true}}',
    ) as unknown;
    reject(polluted);
  });

  it("does not echo rejected values", () => {
    const r = evaluateTrustedProxy({ ...BASE, app: { expressAppFound: "CANARY999" } });
    expect(JSON.stringify(r)).not.toContain("CANARY999");
  });

  it("gives identical output for shuffled and duplicated lists", () => {
    const a = ["10.0.1.0/28", "loopback", "173.245.48.0/20"];
    const mk = (entries: string[]): TrustedProxyInput =>
      build({
        deployment: { topology: "single-proxy", proxyAddresses: [...entries].reverse() },
        trustProxy: { state: "set", value: { kind: "list", entries } },
      });
    const base = JSON.stringify(evaluateTrustedProxy(mk(a)));
    expect(JSON.stringify(evaluateTrustedProxy(mk([...a].reverse())))).toBe(base);
    expect(JSON.stringify(evaluateTrustedProxy(mk([...a, ...a])))).toBe(base);
  });

  it("keeps canaries out of every output for valid hostile-looking values", () => {
    const input = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["10.99.88.77"] },
      trustProxy: {
        state: "set",
        value: { kind: "list", entries: ["10.99.88.77"] },
        location: "../../etc/passwd\nCANARY2",
      },
      coverage: { complete: true, limitsHit: ["CANARY3"] },
    });
    const r = evaluateTrustedProxy(input);
    expect(r.status).toBe("pass");
    expect(JSON.stringify(r)).not.toMatch(CANARIES);
    expect(JSON.stringify(r)).toContain("unknown-location");
  });
});

describe("BFE-006 IP parsing", () => {
  it("parses IPv4 strictly", () => {
    expect(parseIPv4("10.0.1.5")).toEqual([10, 0, 1, 5]);
    for (const bad of [
      "1.2.3",
      "1.2.3.4.5",
      "256.0.0.1",
      "01.2.3.4",
      "1.2.3.a",
      "1..3.4",
      "1.2.3.4444",
    ]) {
      expect(parseIPv4(bad)).toBeUndefined();
    }
  });

  it("parses IPv6 forms and rejects malformed ones", () => {
    expect(parseIPv6("::1")?.[15]).toBe(1);
    expect(parseIPv6("2001:db8::")).toHaveLength(16);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toHaveLength(16);
    expect(parseIPv6("::ffff:1.2.3.4")?.slice(12)).toEqual([1, 2, 3, 4]);
    expect(parseIPv6("1:2:3:4:5:6:1.2.3.4")).toHaveLength(16);
    expect(parseIPv6("FE80::A")).toHaveLength(16);
    for (const bad of [
      ":::",
      "1::2::3",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7::8",
      ":1::",
      "12345::",
      "g::1",
      "::1.2.3",
      "1.2.3.4::",
      "fe80::1%eth0",
    ]) {
      expect(parseIPv6(bad)).toBeUndefined();
    }
  });

  it("parses entries: prefixes, netmasks, names and mapped addresses", () => {
    expect(parseEntry("10.0.0.0/8")?.ranges[0]?.prefix).toBe(8);
    expect(parseEntry("10.0.0.0/255.0.0.0")?.ranges[0]?.prefix).toBe(8);
    expect(parseEntry("0.0.0.0/0.0.0.0")?.ranges[0]?.prefix).toBe(0);
    expect(parseEntry("::ffff:10.0.0.1")?.ranges[0]).toMatchObject({ family: 4, prefix: 32 });
    expect(parseEntry("::ffff:0:0/96")?.ranges[0]).toMatchObject({ family: 4, prefix: 0 });
    expect(parseEntry("::ffff:0:0/80")?.ranges[0]).toMatchObject({ family: 6, prefix: 80 });
    expect(parseEntry("2001:db8::/ffff:ffff::")?.ranges[0]?.prefix).toBe(32);
    expect(parseEntry("loopback")?.named).toBe(true);
    expect(parseEntry("linklocal")?.ranges).toHaveLength(2);
    expect(parseEntry("uniquelocal")?.uniquelocal).toBe(true);
    for (const bad of [
      "Loopback",
      "",
      "10.0.0.0/33",
      "::/129",
      "10.0.0.0/",
      "10.0.0.0/08",
      "10.0.0.0/1/2",
      "10.0.0.0/255.0.255.0",
      "10.0.0.0/ffff::",
      "10.0.0.0/255.255.255.x",
      "10.0.0.0/abc",
    ]) {
      expect(parseEntry(bad)).toBeUndefined();
    }
  });

  it("classifies lists as sets", () => {
    const cls = (e: string[]): string => classifyList(e).cls;
    expect(cls(["10.0.1.5", "bogus"])).toBe("invalid");
    expect(cls(["10.0.1.5", "::/0"])).toBe("trust-all");
    expect(cls(["64.0.0.0/4"])).toBe("very-broad");
    expect(cls(["2000::/8"])).toBe("very-broad");
    expect(cls(["10.0.0.0/7"])).toBe("very-broad");
    expect(cls(["10.0.0.0/8"])).toBe("private-wide");
    expect(cls(["fc00::/7"])).toBe("private-wide");
    expect(cls(["uniquelocal"])).toBe("private-wide");
    expect(cls(["10.0.0.0/16", "8.0.0.0/16", "fd12:3456:789a::/48"])).toBe("specific");
    expect(cls(["::/80"])).toBe("trust-all");
    expect(cls(["::/64"])).toBe("trust-all");
    expect(cls(["10.0.0.5", "::/64"])).toBe("trust-all");
    expect(cls(["::ffff:0:0/96"])).toBe("trust-all");
    expect(cls(["::1/128", "::2/100"])).toBe("specific");
    expect(cls(["3.0.0.0/8"])).toBe("very-broad");
    expect(cls(["2001::/16"])).toBe("very-broad");
    expect(cls(["3.0.0.0/16", "2001:db8::/48"])).toBe("specific");
    expect(cls(["loopback", "linklocal", "2001:db8::/48", "127.0.0.1"])).toBe("specific");
  });

  it("uses IPv6 and mapped addresses when checking declared proxy coverage", () => {
    const input = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["::ffff:10.0.1.5", "fd12::5"] },
      trustProxy: {
        state: "set",
        value: { kind: "list", entries: ["10.0.1.0/24", "fd12::/64"] },
      },
    });
    expect(evaluateTrustedProxy(input).status).toBe("pass");
    const miss = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["fd13::5"] },
      trustProxy: { state: "set", value: { kind: "list", entries: ["fd12::/64"] } },
    });
    expect(evaluateTrustedProxy(miss).status).toBe("warning");
    const named = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["loopback"] },
      trustProxy: { state: "set", value: { kind: "list", entries: ["loopback"] } },
    });
    expect(evaluateTrustedProxy(named).status).toBe("not_assessed");
  });

  it("handles a partial-octet prefix when comparing ranges", () => {
    const input = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["172.16.5.1", "172.32.0.1"] },
      trustProxy: { state: "set", value: { kind: "list", entries: ["172.16.0.0/12"] } },
    });
    // 172.16.0.0/12 spans 172.16-172.31: the second address is outside it.
    expect(JSON.stringify(evaluateTrustedProxy(input).evidence)).toContain("1 not covered");
  });
});

describe("BFE-006 fix loop 1", () => {
  it("does not pass IPv6 ranges that also trust IPv4-mapped peers", () => {
    const a = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["::1"] },
      trustProxy: { state: "set", value: { kind: "list", entries: ["::/80"] } },
    });
    expect(evaluateTrustedProxy(a).status).not.toBe("pass");
    const b = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["10.0.0.5"] },
      trustProxy: { state: "set", value: { kind: "list", entries: ["10.0.0.5", "::/64"] } },
    });
    expect(evaluateTrustedProxy(b).status).not.toBe("pass");
  });

  it("does not pass a wide public range", () => {
    const input = build({
      deployment: { topology: "single-proxy", proxyAddresses: ["3.1.2.3"] },
      trustProxy: { state: "set", value: { kind: "list", entries: ["3.0.0.0/8"] } },
    });
    expect(evaluateTrustedProxy(input).status).toBe("warning");
  });

  it.each([
    "BFE_CANARY_TOKEN_x:1",
    "../x.js:1",
    "/etc/x.conf:1",
    "C:\\x.js:1",
    "a/../b.ts:1",
    "a b.ts:1",
  ])("drops unsafe location %s", (location) => {
    expect(safeLocation(location)).toBeUndefined();
    const r = evaluateTrustedProxy(withValue({ kind: "hops", hops: 1 }, { location }));
    expect(JSON.stringify(r)).not.toMatch(/CANARY|\/etc|\.\.\//);
    expect(r.evidence.some((e) => e.location === "unknown-location")).toBe(true);
  });

  it("keeps safe relative locations", () => {
    for (const ok of ["src/app.ts:12", "config/proxy.conf:3", "a.json:1", "x.mjs:999999999"]) {
      expect(safeLocation(ok)).toBe(ok);
    }
    for (const bad of [
      "src/app.ts",
      "src/app.ts:",
      "src/app.ts:1234567890",
      "src//a.ts:1",
      "app.py:1",
      ":1",
      `${"a".repeat(200)}.ts:1`,
      "src/app.ts:1x",
    ]) {
      expect(safeLocation(bad)).toBeUndefined();
    }
    expect(safeLocation(undefined)).toBeUndefined();
  });
});
