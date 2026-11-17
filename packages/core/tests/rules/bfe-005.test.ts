import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bfe005,
  buildReport,
  builtinRules,
  createRegistry,
  evaluateSensitiveLogging,
  runRules,
  type LoggerDeclaration,
  type SensitiveLoggingInput,
} from "../../src/index.js";
import { decideLogger, parseRedactPath } from "../../src/rules/bfe-005-sensitive-logging.js";

const NOW = "2026-01-02T03:04:05.000Z";
const FIXTURE_DIR = new URL("../../../../tests/fixtures/rules/bfe-005/", import.meta.url);
const CANARY = /BFE_CANARY_/;

interface Fixture {
  name: string;
  overrides: Record<string, unknown>;
  expected: { status: string; confidence: string };
}

const BASE: SensitiveLoggingInput = {
  app: { expressAppFound: true },
  loggers: [],
  coverage: { complete: true, limitsHit: [] },
};

const build = (overrides: Record<string, unknown>): SensitiveLoggingInput =>
  ({ ...BASE, ...overrides }) as SensitiveLoggingInput;

const logger = (o: Partial<LoggerDeclaration> = {}): LoggerDeclaration => ({
  library: "pino",
  kind: "request",
  scope: "global",
  location: "src/app.ts:1",
  emits: { requestHeaders: "no", responseHeaders: "no", requestBody: "no", query: "no" },
  redaction: { state: "none" },
  ...o,
});

const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, FIXTURE_DIR), "utf8")) as Fixture);

describe("BFE-005 fixtures", () => {
  it("covers pass, fail, warning, not_assessed and adversarial cases", () => {
    const statuses = new Set(fixtures.map((f) => f.expected.status));
    expect([...statuses].sort()).toEqual(["fail", "not_assessed", "pass", "warning"]);
    expect(fixtures.some((f) => f.name.startsWith("adversarial"))).toBe(true);
  });

  describe.each(fixtures)("$name", (fx) => {
    const input = build(fx.overrides);
    const result = evaluateSensitiveLogging(input);

    it("returns the expected status and confidence", () => {
      expect({ status: result.status, confidence: result.confidence }).toEqual(fx.expected);
    });

    it("has evidence, no canary, and is deterministic", () => {
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toMatch(CANARY);
      expect(evaluateSensitiveLogging(structuredClone(input))).toEqual(result);
    });
  });
});

describe("BFE-005 decisions", () => {
  it("names unredacted categories, never paths", () => {
    const r = evaluateSensitiveLogging(
      build({
        loggers: [
          logger({
            emits: { requestHeaders: "yes", responseHeaders: "no", requestBody: "no", query: "no" },
            redaction: { state: "paths", paths: ["req.headers.authorization"] },
          }),
        ],
      }),
    );
    const detail = r.evidence[0]?.detail ?? "";
    expect(detail).toContain("Cookie header");
    expect(detail).toContain(
      "unredacted: Proxy-Authorization header, Cookie header, API key header",
    );
    expect(detail).not.toContain("req.headers");
  });

  it("treats unknown parts as not_assessed unless fully redacted", () => {
    const unknownHeaders = logger({
      emits: {
        requestHeaders: "unknown",
        responseHeaders: "unknown",
        requestBody: "no",
        query: "no",
      },
    });
    expect(decideLogger(unknownHeaders).status).toBe("not_assessed");
    const covered = logger({
      emits: {
        requestHeaders: "unknown",
        responseHeaders: "unknown",
        requestBody: "unknown",
        query: "unknown",
      },
      redaction: {
        state: "paths",
        paths: ["req.headers", "res.headers", "req.body", "req.url"],
      },
    });
    expect(decideLogger(covered).status).toBe("pass");
  });

  it("does not let a response-side path cover a request header", () => {
    const o = decideLogger(
      logger({
        emits: { requestHeaders: "yes", responseHeaders: "no", requestBody: "no", query: "no" },
        redaction: { state: "paths", paths: ["res.headers"] },
      }),
    );
    expect(o.status).toBe("fail");
  });

  it("accepts a nested wildcard container but not a root wildcard", () => {
    const paths = [
      "req.*.authorization",
      "req.*.cookie",
      "req.*.proxy-authorization",
      "req.*.x-api-key",
    ];
    const nested = logger({
      emits: { requestHeaders: "yes", responseHeaders: "no", requestBody: "no", query: "no" },
      redaction: { state: "paths", paths },
    });
    expect(decideLogger(nested).status).toBe("pass");
    const root = logger({
      emits: { requestHeaders: "yes", responseHeaders: "no", requestBody: "no", query: "no" },
      redaction: { state: "paths", paths: ["*.authorization", "*.cookie"] },
    });
    expect(decideLogger(root).status).toBe("fail");
  });

  it("partial body field redaction is a fail", () => {
    const o = decideLogger(
      logger({
        emits: { requestHeaders: "no", responseHeaders: "no", requestBody: "yes", query: "no" },
        redaction: { state: "paths", paths: ["req.body.password"] },
      }),
    );
    expect(o.status).toBe("fail");
    expect(o.exposed).toContain("OTP field");
  });

  it("caps evidence and lists the remainder", () => {
    const many = Array.from({ length: 25 }, (_, i) => logger({ location: `src/l${i}.ts:1` }));
    const r = evaluateSensitiveLogging(build({ loggers: many }));
    expect(r.status).toBe("pass");
    expect(r.evidence).toHaveLength(21);
    expect(r.evidence[20]?.detail).toBe("5 more logger(s) not listed");
  });

  it("rejects oversized input without echoing values", () => {
    const r = evaluateSensitiveLogging(
      build({
        loggers: [
          logger({
            redaction: { state: "paths", paths: ["x".repeat(201) + "BFE_CANARY_ENV_a1b2c3"] },
          }),
        ],
      }),
    );
    expect(r.status).toBe("not_assessed");
    expect(JSON.stringify(r)).not.toMatch(CANARY);
    expect(evaluateSensitiveLogging(null).status).toBe("not_assessed");
  });
});

describe("parseRedactPath", () => {
  it.each([
    ["req.headers.authorization", ["req", "headers", "authorization"]],
    ['req.headers["set-cookie"]', ["req", "headers", "set-cookie"]],
    ["req.headers['x-api-key']", ["req", "headers", "x-api-key"]],
    ["a[*].b", ["a", "*", "b"]],
    ["a[0][1]", ["a", "0", "1"]],
  ])("%s", (path, expected) => {
    expect(parseRedactPath(path)).toEqual(expected);
  });

  it.each(["", ".", "a..b", "a.", "a[", 'a["b', 'a["b"x', "a[]", "a[b]c", "a.[b]"])(
    "rejects %j",
    (path) => {
      expect(parseRedactPath(path)).toBeUndefined();
    },
  );
});

describe("BFE-005 registry and engine", () => {
  it("is registered in id order with the blueprint severity", () => {
    const ids = builtinRules.map((r) => r.id);
    expect(ids).toContain("BFE-005");
    expect(ids).toEqual([...ids].sort());
    expect(bfe005.defaultSeverity).toBe("high");
  });

  it("produces a canary-free report through the engine", () => {
    const registry = createRegistry([bfe005]);
    const input = build({
      loggers: [
        logger({
          location: "token=BFE_CANARY_TOKEN_7f3a91",
          emits: { requestHeaders: "yes", responseHeaders: "no", requestBody: "no", query: "no" },
        }),
      ],
    });
    const findings = runRules(registry, input, { now: NOW });
    expect(findings[0]?.status).toBe("fail");
    const report = buildReport({
      findings,
      generatedAt: NOW,
      toolVersion: "0.0.0",
      scanScope: ["src"],
    });
    expect(JSON.stringify(report)).not.toMatch(CANARY);
  });
});

describe("BFE-005 path anchoring (security review)", () => {
  const headersYes = {
    requestHeaders: "yes",
    responseHeaders: "no",
    requestBody: "no",
    query: "no",
  } as const;
  const bodyYes = {
    requestHeaders: "no",
    responseHeaders: "no",
    requestBody: "yes",
    query: "no",
  } as const;
  const queryYes = {
    requestHeaders: "no",
    responseHeaders: "no",
    requestBody: "no",
    query: "yes",
  } as const;
  it.each([
    [["headers"], headersYes],
    [
      [
        "headers.authorization",
        "headers.cookie",
        "headers.proxy-authorization",
        "headers.x-api-key",
      ],
      headersYes,
    ],
    [["err.headers"], headersYes],
    [["Res.headers", "Req.headers"], headersYes],
    [["req.headers.x.authorization"], headersYes],
    [["body"], bodyYes],
    [["body.*.authorization", "query.body"], bodyYes],
    [["url", "res.query"], queryYes],
  ] as const)("%j does not cover the request", (paths, emits) => {
    const o = decideLogger(logger({ emits, redaction: { state: "paths", paths: [...paths] } }));
    expect(o.status).not.toBe("pass");
  });

  it.each([
    [["req.headers"], headersYes],
    [["*.headers.*"], headersYes],
    [["request.body"], bodyYes],
    [["req.query"], queryYes],
  ] as const)("%j covers the request", (paths, emits) => {
    const o = decideLogger(logger({ emits, redaction: { state: "paths", paths: [...paths] } }));
    expect(o.status).toBe("pass");
  });
});
