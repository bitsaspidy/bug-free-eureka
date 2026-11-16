import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bfe001,
  builtinRules,
  createRegistry,
  evaluateSecurityHeaders,
  runRules,
  type HeaderObservation,
  type SecurityHeadersInput,
} from "../../src/index.js";

const NOW = "2026-01-02T03:04:05.000Z";
const FIXTURE_DIR = new URL("../../../../tests/fixtures/rules/bfe-001/", import.meta.url);

interface Fixture {
  name: string;
  overrides: Record<string, unknown>;
  expected: { status: string; confidence: string };
}

const BASE: SecurityHeadersInput = {
  app: { kind: "html", expressAppFound: true },
  transport: { https: "app" },
  proxy: { present: "no", headerConfig: "not_supplied" },
  coverage: { complete: true, limitsHit: [], unresolvedMiddleware: false },
  settings: { poweredBy: "unknown" },
  helmet: { dependency: "absent", mounts: [] },
  headers: [],
};

function build(overrides: Record<string, unknown>): SecurityHeadersInput {
  const out: Record<string, unknown> = { ...BASE };
  for (const [key, value] of Object.entries(overrides)) {
    const prev = out[key];
    out[key] =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof prev === "object"
        ? { ...(prev as object), ...value }
        : value;
  }
  return out as unknown as SecurityHeadersInput;
}

function hdr(name: string, value?: string, o: Partial<HeaderObservation> = {}): HeaderObservation {
  return {
    name,
    state: "set",
    layer: "app",
    scope: "global",
    origin: "source",
    ...(value === undefined ? {} : { value }),
    ...o,
  };
}

const OK_HEADERS = [
  hdr("content-security-policy", "default-src 'self'; script-src 'self'; frame-ancestors 'self'"),
  hdr("strict-transport-security", "max-age=31536000"),
  hdr("x-content-type-options", "nosniff"),
  hdr("x-frame-options", "DENY"),
  hdr("referrer-policy", "strict-origin-when-cross-origin"),
  hdr("cross-origin-opener-policy", "same-origin"),
  hdr("cross-origin-resource-policy", "same-site"),
];

const without = (...names: string[]) => OK_HEADERS.filter((h) => !names.includes(h.name));
const withValue = (name: string, value: string) =>
  OK_HEADERS.map((h) => (h.name === name ? { ...h, value } : h));
const run = (overrides: Record<string, unknown>) => evaluateSecurityHeaders(build(overrides));
const detail = (r: ReturnType<typeof run>, id: string) =>
  r.evidence.find((e) => e.detail.startsWith(`${id} `))?.detail ?? "";
const PASS = { settings: { poweredBy: "disabled" } };

const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, FIXTURE_DIR), "utf8")) as Fixture);

describe("BFE-001 spec fixtures", () => {
  it("covers all 24 spec fixtures plus the HSTS-missing fixture", () => {
    expect(fixtures).toHaveLength(25);
  });

  describe.each(fixtures)("$name", (fx) => {
    const input = build(fx.overrides);
    const result = evaluateSecurityHeaders(input);

    it("returns the expected status and confidence", () => {
      expect({ status: result.status, confidence: result.confidence }).toEqual(fx.expected);
    });

    it("has non-empty evidence and is deterministic", () => {
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence.every((e) => e.detail.length > 0)).toBe(true);
      expect(evaluateSecurityHeaders(structuredClone(input))).toEqual(result);
    });

    it("gives the same result for shuffled header order", () => {
      const reversed = { ...input, headers: [...input.headers].reverse() };
      expect(evaluateSecurityHeaders(reversed)).toEqual(result);
    });

    it("never contains canaries or raw header values", () => {
      const text = JSON.stringify(result);
      expect(text).not.toMatch(/CANARY\d+/);
      expect(text).not.toContain("report-uri");
      expect(text).not.toContain("sid=");
    });
  });
});

describe("BFE-001 rule metadata and engine integration", () => {
  it("produces exactly one aggregated finding via the engine", () => {
    const findings = runRules(createRegistry(builtinRules), build({}), { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "BFE-001", severity: "medium", status: "fail" });
    expect(findings[0]?.references).toHaveLength(8);
  });

  it("registry is sorted by id and the description makes no security guarantee", () => {
    expect(builtinRules.map((r) => r.id)).toEqual(["BFE-001"]);
    expect(bfe001.description).not.toMatch(/compliant|bug-free/i);
  });

  it("reports invalid input as not_assessed without echoing values", () => {
    const r = bfe001.evaluate({
      input: { app: { kind: "html", expressAppFound: "CANARY999" } },
      now: NOW,
    });
    expect(r.status).toBe("not_assessed");
    expect(r.evidence[0]?.detail).toMatch(/^input invalid: /);
    expect(JSON.stringify(r)).not.toContain("CANARY999");
    expect(evaluateSecurityHeaders(null).status).toBe("not_assessed");
    expect(evaluateSecurityHeaders({ ...BASE, extra: 1 }).status).toBe("not_assessed");
  });
});

describe("BFE-001 header value checks", () => {
  it("H1 accepts case-insensitive trimmed nosniff and non-literal values", () => {
    const a = run({ ...PASS, headers: withValue("x-content-type-options", "  NoSniff ") });
    expect(detail(a, "H1")).toContain("pass");
    const b = run({
      ...PASS,
      headers: [...without("x-content-type-options"), hdr("x-content-type-options")],
    });
    expect(detail(b, "H1")).toContain("warning (low)");
  });

  it("H2 variants", () => {
    const noXfoNoCsp = without("x-frame-options", "content-security-policy");
    const wild = run({
      ...PASS,
      headers: [...without("x-frame-options"), hdr("content-security-policy", "frame-ancestors *")],
    });
    expect(detail(wild, "H2")).toContain("warning");
    const scheme = run({
      ...PASS,
      headers: [
        ...noXfoNoCsp,
        hdr("content-security-policy", "default-src 'self'; frame-ancestors https:"),
      ],
    });
    expect(detail(scheme, "H2")).toContain("warning");
    const allow = run({
      ...PASS,
      headers: [...noXfoNoCsp, hdr("x-frame-options", "ALLOW-FROM https://a.example")],
    });
    expect(detail(allow, "H2")).toContain("fail");
    const same = run({ ...PASS, headers: [...noXfoNoCsp, hdr("x-frame-options", "sameorigin")] });
    expect(detail(same, "H2")).toContain("pass");
    const nl = run({ ...PASS, headers: [...noXfoNoCsp, hdr("x-frame-options")] });
    expect(detail(nl, "H2")).toContain("warning (low)");
    const cspNoFrame = run({
      ...PASS,
      headers: [...noXfoNoCsp, hdr("content-security-policy", "default-src 'self'")],
    });
    expect(detail(cspNoFrame, "H2")).toContain("fail");
  });

  it("H3 variants", () => {
    const csp = (v: string) =>
      detail(run({ ...PASS, headers: withValue("content-security-policy", v) }), "H3");
    expect(csp("script-src 'self' 'unsafe-inline' 'nonce-abc'")).toContain("pass");
    expect(csp("script-src 'self' 'unsafe-inline' 'strict-dynamic'")).toContain("pass");
    expect(csp("script-src 'self' 'sha256-abc'")).toContain("pass");
    expect(csp("default-src 'self'; style-src 'unsafe-inline'")).toContain("pass");
    expect(csp("default-src 'unsafe-inline'")).toContain("warning");
    expect(csp("script-src 'unsafe-eval' * data: http:")).toContain("warning");
    expect(csp("img-src 'self'")).toContain("no script-src or default-src");
    const ro = run({
      ...PASS,
      headers: [
        ...without("content-security-policy"),
        hdr("content-security-policy-report-only", "default-src 'self'"),
      ],
    });
    expect(detail(ro, "H3")).toContain("Report-Only");
    const nl = run({
      ...PASS,
      headers: [...without("content-security-policy"), hdr("content-security-policy")],
    });
    expect(detail(nl, "H3")).toContain("warning (low)");
  });

  it("H4 variants", () => {
    const hsts = (v: string) =>
      detail(run({ ...PASS, headers: withValue("strict-transport-security", v) }), "H4");
    expect(hsts("max-age=0")).toContain("warning");
    expect(hsts("includeSubDomains")).toContain("no valid max-age");
    expect(hsts("max-age=abc")).toContain("no valid max-age");
    expect(hsts('max-age="31536000"; preload')).toContain("pass");
    expect(hsts("max-age=300")).toContain("max-age=300");
    const none = run({
      ...PASS,
      transport: { https: "none" },
      headers: without("strict-transport-security"),
    });
    expect(detail(none, "H4")).toContain("not evaluated");
    expect(none.status).toBe("pass");
  });

  it("H5, H6, H7 variants", () => {
    const h = (name: string, v: string, id: string) =>
      detail(run({ ...PASS, headers: withValue(name, v) }), id);
    expect(h("referrer-policy", "unsafe-url", "H5")).toContain("warning");
    expect(h("referrer-policy", "no-referrer-when-downgrade", "H5")).toContain("warning");
    expect(h("referrer-policy", "bogus", "H5")).toContain("warning");
    expect(h("referrer-policy", "bogus, same-origin", "H5")).toContain("pass");
    expect(h("referrer-policy", "no-referrer", "H5")).toContain("pass");
    expect(h("cross-origin-opener-policy", "unsafe-none", "H6")).toContain("warning");
    expect(h("cross-origin-opener-policy", "same-origin-allow-popups", "H6")).toContain("pass");
    expect(h("cross-origin-resource-policy", "bogus", "H7")).toContain("warning");
    expect(h("cross-origin-resource-policy", "cross-origin", "H7")).toContain("pass");
    const nl = run({ ...PASS, headers: [...without("referrer-policy"), hdr("referrer-policy")] });
    expect(detail(nl, "H5")).toContain("warning (low)");
  });

  it("H8 and H9 variants", () => {
    const set = run({ headers: [...OK_HEADERS, hdr("x-powered-by", "Express")] });
    expect(detail(set, "H8")).toContain("warning");
    const removed = run({
      headers: [
        ...OK_HEADERS,
        hdr("x-powered-by", undefined, { state: "removed", origin: "declared" }),
      ],
    });
    expect(detail(removed, "H8")).toContain("pass (high)");
    const proxyRemoves = run({
      headers: [
        ...OK_HEADERS,
        hdr("x-powered-by", "Express"),
        hdr("x-powered-by", undefined, { state: "removed", layer: "proxy", origin: "declared" }),
      ],
    });
    expect(detail(proxyRemoves, "H8")).toContain("pass");
    const zero = run({ ...PASS, headers: [...OK_HEADERS, hdr("x-xss-protection", "0")] });
    expect(detail(zero, "H9")).toContain("pass");
    const nl = run({ ...PASS, headers: [...OK_HEADERS, hdr("x-xss-protection")] });
    expect(detail(nl, "H9")).toContain("warning (low)");
    const routeOnly = run({
      headers: [...OK_HEADERS, hdr("x-powered-by", "Express", { scope: "route", route: "/a?b=c" })],
    });
    expect(detail(routeOnly, "H8")).toContain("warning");
    expect(
      run({ settings: { poweredBy: "enabled" }, headers: OK_HEADERS })
        .evidence.map((e) => e.detail)
        .join(),
    ).toContain("enabled in app settings");
  });

  it("H10 is advisory only and never changes status", () => {
    const a = run({ ...PASS, headers: OK_HEADERS });
    const b = run({ ...PASS, headers: [...OK_HEADERS, hdr("permissions-policy", "camera=()")] });
    expect(a.status).toBe("pass");
    expect(b.status).toBe(a.status);
    expect(detail(a, "H10")).toContain("not observed");
    expect(detail(b, "H10")).toContain("observed");
  });

  it("api kind skips html-only headers with an evidence line", () => {
    const r = run({
      app: { kind: "api" },
      ...PASS,
      headers: [
        hdr("x-content-type-options", "nosniff"),
        hdr("strict-transport-security", "max-age=31536000"),
      ],
    });
    expect(detail(r, "H3")).toContain("not evaluated: declared API-only");
    expect(r.evidence.some((e) => e.detail.startsWith("H10"))).toBe(false);
  });
});

describe("BFE-001 decision table", () => {
  const edge = { capturedAt: "edge", scheme: "https", route: "/?token=CANARY1", isHtml: "yes" };
  const sh = { layer: "sample", origin: "sample" } as const;
  const asSample = (list: HeaderObservation[]) => list.map((h) => ({ ...h, ...sh }));

  it("unknown app kind caps html-only absence at warning, never fail", () => {
    const r = run({
      app: { kind: "unknown" },
      ...PASS,
      headers: without("content-security-policy", "x-frame-options"),
    });
    expect(detail(r, "H2")).toContain("warning");
    expect(detail(r, "H3")).toContain("warning");
    expect(r.status).toBe("warning");
  });

  it("mixed kind fails on absent html-only headers", () => {
    const r = run({
      app: { kind: "mixed" },
      ...PASS,
      headers: without("content-security-policy", "x-frame-options"),
    });
    expect(r.status).toBe("fail");
  });

  it("edge sample over http gives not_assessed for HSTS", () => {
    const r = run({
      sample: { ...edge, scheme: "http" },
      headers: asSample(without("strict-transport-security")),
    });
    expect(detail(r, "H4")).toContain("not_assessed");
    expect(JSON.stringify(r)).not.toContain("CANARY1");
  });

  it("non-edge sample cases", () => {
    const origin = { ...edge, capturedAt: "origin" };
    const http = run({
      sample: { ...origin, scheme: "http" },
      ...PASS,
      proxy: { present: "yes", headerConfig: "supplied" },
      headers: asSample(without("strict-transport-security")),
    });
    expect(detail(http, "H4")).toContain("not_assessed");
    const httpNoProxy = run({
      sample: { ...origin, scheme: "http" },
      ...PASS,
      headers: asSample(without("strict-transport-security")),
    });
    expect(detail(httpNoProxy, "H4")).toContain("not over HTTPS");
    const unknownCapture = run({
      sample: { ...origin, capturedAt: "unknown" },
      ...PASS,
      proxy: { present: "unknown", headerConfig: "not_supplied" },
      headers: [],
    });
    expect(unknownCapture.status).toBe("not_assessed");
    const absentNoProxy = run({ sample: origin, ...PASS, headers: [] });
    expect(absentNoProxy.status).toBe("fail");
    expect(absentNoProxy.confidence).toBe("medium");
  });

  it("an edge sample of a non-HTML route does not prove absence", () => {
    const r = run({
      sample: { ...edge, isHtml: "no" },
      ...PASS,
      headers: [hdr("x-content-type-options", "nosniff", sh)],
    });
    expect(detail(r, "H1")).toContain("pass (medium)");
    expect(detail(r, "H3")).toContain("fail");
  });

  it("sample-layer headers without a sample are ignored", () => {
    const r = run({ headers: [hdr("x-content-type-options", "nosniff", sh)] });
    expect(detail(r, "H1")).toContain("fail");
  });

  it("D6: route-scoped headers warn and name routes without query strings", () => {
    const r = run({
      ...PASS,
      headers: [
        ...without("x-content-type-options"),
        hdr("x-content-type-options", "nosniff", {
          scope: "route",
          route: "/up?secret=CANARY2#frag",
        }),
      ],
    });
    expect(detail(r, "H1")).toContain("1 observation");
    expect(JSON.stringify(r)).not.toContain("CANARY2");
  });

  it("D7: unresolved middleware and incomplete coverage are not_assessed", () => {
    expect(run({ coverage: { unresolvedMiddleware: true } }).status).toBe("not_assessed");
    const r = run({ coverage: { complete: false, limitsHit: ["max-files"] } });
    expect(r.evidence.some((e) => e.detail.includes("1 limit hit"))).toBe(true);
  });

  it("D7: no Express app but proxy evidence is not_assessed for unseen headers", () => {
    const r = run({
      app: { expressAppFound: false },
      proxy: { present: "yes", headerConfig: "supplied" },
      headers: [hdr("x-content-type-options", "nosniff", { layer: "proxy", origin: "declared" })],
    });
    expect(r.status).toBe("not_assessed");
    expect(detail(r, "H1")).toContain("pass");
  });

  it("proxy unknown: H9 is not assessed, others warn at low confidence", () => {
    const r = run({ proxy: { present: "unknown", headerConfig: "not_supplied" } });
    expect(detail(r, "H9")).toContain("not_assessed");
    expect(detail(r, "H1")).toContain("warning (low)");
  });

  it("helmet options: custom, disabled, route scope, unresolved, versions", () => {
    const mounts = (options: unknown, scope = "global") => ({
      helmet: {
        dependency: "present",
        version: "8.1.0",
        mounts: [{ scope, location: "src/a.ts:1", options }],
      },
    });
    const custom = run(
      mounts({
        "content-security-policy": { state: "custom", value: "script-src 'self' 'unsafe-eval'" },
        "x-frame-options": { state: "custom" },
        "x-xss-protection": { state: "disabled" },
        "x-powered-by": { state: "default" },
      }),
    );
    expect(detail(custom, "H3")).toContain("warning");
    expect(detail(custom, "H2")).toContain("warning");
    expect(detail(custom, "H9")).toContain("pass");
    const route = run(mounts("default", "route"));
    expect(detail(route, "H1")).toContain("route-scoped");
    expect(run(mounts("unresolved")).status).toBe("not_assessed");
    const noMount = run({ helmet: { dependency: "present", mounts: [] } });
    expect(noMount.evidence.some((e) => e.detail.includes("presence is not use"))).toBe(true);
    const old = run({
      helmet: {
        dependency: "present",
        version: "5.0.0",
        mounts: [{ scope: "global", location: "x:1", options: "default" }],
      },
    });
    expect(old.confidence).toBe("low");
    const ranged = run({
      ...PASS,
      helmet: {
        dependency: "present",
        version: ">=8",
        mounts: [{ scope: "global", location: "x:1", options: "default" }],
      },
    });
    expect(ranged.status).toBe("pass");
    const proto = JSON.parse(
      '{"__proto__":{"state":"disabled"},"constructor":{"state":"disabled"}}',
    );
    expect(() => run(mounts(proto))).not.toThrow();
  });

  it("explicit absent observations outside a sample are ignored", () => {
    const r = run({ headers: [{ ...hdr("x-content-type-options"), state: "absent" }] });
    expect(detail(r, "H1")).toContain("fail");
  });

  it("remediation mentions a proxy block only when a proxy may exist", () => {
    expect(run({}).remediation).not.toContain("Nginx");
    expect(
      run({ proxy: { present: "unknown", headerConfig: "not_supplied" } }).remediation,
    ).toContain("Nginx");
    expect(run({ ...PASS, headers: OK_HEADERS }).remediation).toContain("not a guarantee");
  });
});

describe("BFE-001 invariants and adversarial input", () => {
  it("no fail behind an unconfigured proxy unless a literal defect proves it", () => {
    for (const present of ["yes", "unknown"] as const) {
      const r = run({ proxy: { present, headerConfig: "not_supplied" }, headers: [] });
      expect(r.status).not.toBe("fail");
    }
    const defect = run({
      proxy: { present: "yes", headerConfig: "not_supplied" },
      headers: [hdr("x-content-type-options", "sniff")],
    });
    expect(defect.status).toBe("fail");
  });

  it("pass never comes from absence of evidence", () => {
    expect(run({ headers: [] }).status).not.toBe("pass");
    expect(run({ app: { kind: "api" }, headers: [] }).status).not.toBe("pass");
  });

  it("handles a 1 MB CSP value, prototype-pollution names and unknown names", () => {
    const huge = `default-src 'self'; script-src 'self' ${"https://a.example ".repeat(60_000)}'unsafe-inline'`;
    const input = build({
      ...PASS,
      headers: [
        ...without("content-security-policy"),
        hdr("content-security-policy", huge),
        hdr("__proto__", "x"),
        hdr("constructor", "x"),
        hdr("prototype", "x"),
        hdr("set-cookie", "sid=CANARY123"),
      ],
    });
    const a = evaluateSecurityHeaders(input);
    const b = evaluateSecurityHeaders({ ...input, headers: [...input.headers].reverse() });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain("CANARY123");
    expect(JSON.stringify(a).length).toBeLessThan(20_000);
  });

  it("rejects oversized values as invalid input without echoing them", () => {
    const r = run({ headers: [hdr("x-content-type-options", "x".repeat(5 * 1024 * 1024))] });
    expect(r.status).toBe("not_assessed");
    expect(r.evidence[0]?.detail).toMatch(/^input invalid: headers\.0\.value/);
  });
});

describe("BFE-001 fix loop 1", () => {
  const CANARY = "BFE_CANARY_";
  const mount = (location: string) => ({
    helmet: {
      dependency: "present",
      version: "^8.0.0",
      mounts: [
        { scope: "conditional", location, options: "default" },
        {
          scope: "global",
          location,
          options: { "content-security-policy": { state: "disabled" } },
        },
      ],
    },
  });

  it("HSTS missing over HTTPS with every other header present is a fail", () => {
    const r = run({
      ...PASS,
      transport: { https: "app" },
      headers: without("strict-transport-security"),
    });
    expect(r.status).toBe("fail");
    expect(detail(r, "H4")).toContain("fail");
  });

  it("A1: app-layer headers without an Express app, sample or proxy evidence are not_assessed", () => {
    const r = run({ app: { expressAppFound: false }, ...PASS, headers: OK_HEADERS });
    expect(r.status).toBe("not_assessed");
    expect(r.evidence[0]?.detail).toContain("no Express app was resolved");
    expect(run({ app: { expressAppFound: true }, ...PASS, headers: OK_HEADERS }).status).toBe(
      "pass",
    );
  });

  it("does not echo hostile mount locations, header locations, routes or limitsHit text", () => {
    const hostile = `${CANARY}loc secret=1`;
    const r = run({
      ...mount(hostile),
      coverage: { complete: false, limitsHit: [`${CANARY}limit`] },
      headers: [
        hdr("x-content-type-options", "nosniff", { location: hostile }),
        hdr("x-frame-options", "DENY", { scope: "route", route: `/${CANARY}route?x=1` }),
      ],
      sample: { capturedAt: "origin", scheme: "https", route: `/${CANARY}sample`, isHtml: "yes" },
    });
    expect(JSON.stringify(r)).not.toMatch(/BFE_CANARY_/);
    const ok = run({ ...mount("src/a.ts:12"), headers: [] });
    expect(ok.evidence.some((e) => e.location === "src/a.ts:12")).toBe(true);
    const bad = run({ ...mount("../x:y z:1") });
    expect(
      bad.evidence.every((e) => e.location === undefined || e.location === "unknown-location"),
    ).toBe(true);
  });

  it("rejects too many helmet option keys, headers and mounts", () => {
    const keys = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`k${i}`, { state: "default" }]),
    );
    const a = run({
      helmet: {
        dependency: "present",
        mounts: [{ scope: "global", location: "a:1", options: keys }],
      },
    });
    expect(a.status).toBe("not_assessed");
    expect(a.evidence[0]?.detail).toContain("input invalid");
    const b = run({ headers: Array.from({ length: 501 }, () => hdr("x-powered-by", "x")) });
    expect(b.evidence[0]?.detail).toContain("input invalid: headers");
    const m = Array.from({ length: 51 }, () => ({
      scope: "global",
      location: "a:1",
      options: "default",
    }));
    expect(run({ helmet: { dependency: "present", mounts: m } }).evidence[0]?.detail).toContain(
      "input invalid",
    );
  });

  it("D3: non-literal values and unknown helmet versions never pass", () => {
    const nl = run({
      ...PASS,
      headers: [...without("x-content-type-options"), hdr("x-content-type-options")],
    });
    expect(detail(nl, "H1")).toContain("warning (low)");
    expect(nl.status).toBe("warning");
    const unknown = run({
      helmet: {
        dependency: "present",
        version: "latest",
        mounts: [{ scope: "global", location: "a:1", options: "default" }],
      },
    });
    expect(unknown.status).toBe("warning");
    expect(detail(unknown, "H8")).toContain("warning (low)");
    expect(detail(unknown, "H8")).toBeTruthy();
  });
});
