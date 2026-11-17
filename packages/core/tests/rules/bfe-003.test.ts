import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bfe003,
  builtinRules,
  createRegistry,
  evaluateRequestSize,
  runRules,
  type RequestSizeInput,
} from "../../src/index.js";

const NOW = "2026-01-02T03:04:05.000Z";
const FIXTURE_DIR = new URL("../../../../tests/fixtures/rules/bfe-003/", import.meta.url);

interface Fixture {
  name: string;
  overrides: Record<string, unknown>;
  expected: { status: string; confidence: string };
}

const BASE: RequestSizeInput = {
  app: { expressAppFound: true, expressMajor: 5, legacyBodyParser: false },
  coverage: { complete: true, limitsHit: [], unresolvedMiddleware: false },
  declarations: [],
  proxy: { present: "no", bodyLimitConfig: "not_supplied", appReachableDirectly: "unknown" },
};

function build(overrides: Record<string, unknown>): RequestSizeInput {
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
  return out as unknown as RequestSizeInput;
}

const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, FIXTURE_DIR), "utf8")) as Fixture);

const D = { state: "default" } as const;
const U = { state: "unbounded" } as const;
const L = (bytes: number) => ({ state: "literal", bytes }) as const;
const decl = (over: Record<string, unknown> = {}) => ({
  kind: "json",
  source: "express",
  scope: "global",
  location: "src/app.ts:10",
  limit: D,
  ...over,
});
const multer = (over: Record<string, unknown> = {}) => ({
  storage: "memory",
  limitsObject: "literal",
  files: L(3),
  fields: L(10),
  fieldSize: D,
  parts: L(20),
  ...over,
});
const omit = (o: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const run = (overrides: Record<string, unknown>) => evaluateRequestSize(build(overrides));
const detailText = (r: ReturnType<typeof run>) => r.evidence.map((e) => e.detail).join("\n");

describe("BFE-003 spec fixtures", () => {
  it("covers every JSON fixture (spec 1-30 and 34-36; 31-33 are code tests below)", () => {
    expect(fixtures).toHaveLength(33);
    expect(fixtures[5]?.name).toBe("warning-proxy-cap-declared");
    expect(fixtures[19]?.name).toBe("fail-proxy-nginx-partial");
  });

  describe.each(fixtures)("$name", (fx) => {
    const input = build(fx.overrides);
    const result = evaluateRequestSize(input);

    it("returns the expected status and confidence", () => {
      expect({ status: result.status, confidence: result.confidence }).toEqual(fx.expected);
    });

    it("has non-empty evidence and is deterministic", () => {
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence.every((e) => e.detail.length > 0)).toBe(true);
      expect(evaluateRequestSize(structuredClone(input))).toEqual(result);
    });

    it("is stable under shuffled declaration order", () => {
      const reversed = { ...input, declarations: [...input.declarations].reverse() };
      expect(JSON.stringify(evaluateRequestSize(reversed))).toBe(JSON.stringify(result));
    });

    it("never contains canaries", () => {
      expect(JSON.stringify(result)).not.toMatch(/CANARY\d+/);
    });
  });
});

describe("BFE-003 adversarial inputs (spec 31-33)", () => {
  it("accepts 200 declarations and itemizes 20", () => {
    const r = run({ declarations: Array.from({ length: 200 }, () => decl()) });
    expect(r.status).toBe("pass");
    expect(r.evidence.filter((e) => e.source === "source")).toHaveLength(20);
    expect(detailText(r)).toContain("and 180 more declarations");
  });

  it.each([
    ["201 declarations", { declarations: Array.from({ length: 201 }, () => decl()) }],
    ["bytes 0", { declarations: [decl({ limit: L(0) })] }],
    ["bytes -1", { declarations: [decl({ limit: L(-1) })] }],
    ["bytes NaN", { declarations: [decl({ limit: L(Number.NaN) })] }],
    ["bytes as string", { declarations: [decl({ limit: { state: "literal", bytes: "1e400" } })] }],
    ["bytes Infinity", { declarations: [decl({ limit: L(Infinity) })] }],
    ["bytes float", { declarations: [decl({ limit: L(1.5) })] }],
    ["bytes above safe int", { declarations: [decl({ limit: L(2 ** 53) })] }],
    ["unknown kind", { declarations: [decl({ kind: "CANARY777" })] }],
    ["1 MB location", { declarations: [decl({ location: "a".repeat(1_000_000) })] }],
    ["missing limit", { declarations: [omit(decl(), "limit")] }],
    ["multer details missing", { declarations: [decl({ kind: "multer" })] }],
    ["unknown key", { extra: 1 }],
    ["options unordered", { options: { warnBytes: 10, failBytes: 5 } }],
  ])("rejects %s as not_assessed without echoing values", (_name, over) => {
    const r = run(over as Record<string, unknown>);
    expect(r.status).toBe("not_assessed");
    expect(r.evidence[0]?.detail).toMatch(/^input invalid: /);
    expect(JSON.stringify(r)).not.toContain("CANARY777");
    expect(JSON.stringify(r)).not.toContain("1e400");
  });

  it("rejects non-object input", () => {
    expect(evaluateRequestSize(null).status).toBe("not_assessed");
    expect(evaluateRequestSize("CANARY888").status).toBe("not_assessed");
  });

  it("rejects prototype-polluting keys in a multer object", () => {
    const polluted = JSON.parse(
      '{"storage":"memory","limitsObject":"literal","__proto__":{"fileSize":1},"constructor":1,' +
        '"files":{"state":"default"},"fields":{"state":"default"},"fieldSize":{"state":"default"},"parts":{"state":"default"}}',
    ) as Record<string, unknown>;
    const r = run({ declarations: [decl({ kind: "multer", limit: D, multer: polluted })] });
    expect(r.status).toBe("not_assessed");
    expect(r.evidence[0]?.detail).toMatch(/^input invalid: /);
    expect(({} as Record<string, unknown>).fileSize).toBeUndefined();
  });

  it("replaces unsafe locations with unknown-location and echoes safe ones", () => {
    const r = run({
      declarations: [
        decl({ limit: U, location: "CANARY123 secret:1" }),
        decl({ limit: U, location: "src/app.ts:7" }),
      ],
    });
    expect(r.evidence.map((e) => e.location)).toContain("unknown-location");
    expect(r.evidence.map((e) => e.location)).toContain("src/app.ts:7");
    expect(JSON.stringify(r)).not.toContain("CANARY123");
  });

  it("does not echo limitsHit text, only counts", () => {
    const r = run({
      coverage: { complete: false, limitsHit: ["CANARY456", "CANARY789"] },
      declarations: [],
    });
    expect(r.status).toBe("not_assessed");
    expect(JSON.stringify(r)).not.toMatch(/CANARY\d+/);
    expect(detailText(r)).toContain("2 limits hit");
  });

  it("nginx entry order does not change the result", () => {
    const entries = [
      { scope: "server", value: L(1048576), locationCount: 0 },
      { scope: "location", value: { state: "unlimited" }, locationCount: 2 },
    ];
    const proxy = (list: unknown[]) => ({
      present: "yes",
      bodyLimitConfig: "supplied",
      appReachableDirectly: "no",
      nginx: { clientMaxBodySize: list, configComplete: true },
    });
    const a = run({ proxy: proxy(entries), declarations: [decl({ limit: U })] });
    const b = run({ proxy: proxy([...entries].reverse()), declarations: [decl({ limit: U })] });
    expect(a.status).toBe("fail");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("BFE-003 decision branches", () => {
  it("applies route and global thresholds and custom options", () => {
    expect(run({ declarations: [decl({ scope: "route", limit: L(10_485_761) })] }).status).toBe(
      "warning",
    );
    expect(run({ declarations: [decl({ limit: L(1_048_577) })] }).status).toBe("warning");
    expect(run({ declarations: [decl({ limit: L(1_048_576) })] }).status).toBe("pass");
    expect(
      run({
        options: { warnBytes: 2_000_000 },
        declarations: [decl({ limit: L(1_500_000) })],
      }).status,
    ).toBe("pass");
  });

  it("flags urlencoded parameterLimit variants", () => {
    const urlenc = (parameterLimit: unknown) =>
      run({ declarations: [decl({ kind: "urlencoded", parameterLimit })] });
    expect(urlenc(U).status).toBe("warning");
    expect(urlenc({ state: "non-literal" }).status).toBe("not_assessed");
    expect(urlenc(L(1000)).status).toBe("pass");
    expect(urlenc(D).status).toBe("pass");
  });

  it("multer fileSize and count variants", () => {
    const m = (limit: unknown, over: Record<string, unknown> = {}, storage = "memory") =>
      run({
        declarations: [
          decl({ kind: "multer", source: "multer", limit, multer: multer({ storage, ...over }) }),
        ],
      }).status;
    expect(m(U)).toBe("fail");
    expect(m(L(200_000_000))).toBe("fail");
    expect(m({ state: "non-literal" })).toBe("not_assessed");
    expect(m(L(20_000_000))).toBe("warning");
    expect(m(L(20_000_000), {}, "disk")).toBe("pass");
    expect(m(L(200_000_000), {}, "disk")).toBe("fail");
    expect(m(L(1000), { files: L(500) })).toBe("warning");
    expect(m(L(1000), { fields: U })).toBe("warning");
    expect(m(L(1000), { parts: { state: "non-literal" } })).toBe("not_assessed");
    expect(m(L(1000), { limitsObject: "non-literal" })).toBe("not_assessed");
  });

  it("custom-reader with a byte counter is not_assessed and never fails", () => {
    const r = run({
      declarations: [decl({ kind: "custom-reader", source: "other", byteCounted: true })],
    });
    expect(r.status).toBe("not_assessed");
    const unseen = run({
      proxy: { present: "unknown" },
      declarations: [omit(decl({ kind: "custom-reader" }), "limit")],
    });
    expect(unseen.status).toBe("warning");
  });

  it("proxy declared cap variants", () => {
    const p = (declaredLimit: unknown, reach = "no") =>
      run({
        proxy: { present: "yes", appReachableDirectly: reach, declaredLimit },
        declarations: [decl({ limit: U })],
      });
    expect(p(L(1_048_576))).toMatchObject({ status: "warning", confidence: "high" });
    expect(p(L(1_048_576), "yes")).toMatchObject({ status: "warning", confidence: "low" });
    expect(p(L(200_000_000)).status).toBe("fail");
    expect(p(U).status).toBe("fail");
    expect(p({ state: "non-literal" }).status).toBe("not_assessed");
  });

  it("nginx non-literal and loose http cap", () => {
    const n = (entries: unknown[]) =>
      run({
        proxy: {
          present: "yes",
          bodyLimitConfig: "supplied",
          nginx: { clientMaxBodySize: entries, configComplete: true },
        },
        declarations: [decl({ limit: U })],
      });
    expect(n([{ scope: "http", value: { state: "non-literal" }, locationCount: 0 }]).status).toBe(
      "not_assessed",
    );
    expect(n([{ scope: "http", value: L(200_000_000), locationCount: 0 }]).status).toBe("fail");
  });

  it("proxy-capped warnings (P5) are adjusted, and unknown proxy lowers them", () => {
    const over = { declarations: [decl({ limit: L(5_242_880) })] };
    expect(run(over)).toMatchObject({ status: "warning", confidence: "medium" });
    expect(run({ ...over, proxy: { present: "unknown" } })).toMatchObject({
      status: "warning",
      confidence: "low",
    });
  });

  it("a fail plus an unresolved declaration stays fail and says it is incomplete", () => {
    const r = run({ declarations: [decl({ limit: U }), decl({ scope: "unresolved" })] });
    expect(r.status).toBe("fail");
    expect(detailText(r)).toContain("result is incomplete");
  });

  it("incomplete coverage with a resolved pass is not_assessed", () => {
    const r = run({
      coverage: { complete: false, limitsHit: ["x"] },
      declarations: [decl()],
    });
    expect(r.status).toBe("not_assessed");
    const dyn = run({ coverage: { unresolvedMiddleware: true }, declarations: [] });
    expect(dyn.status).toBe("not_assessed");
    const dyn1 = run({ coverage: { complete: false, limitsHit: ["x"] }, declarations: [] });
    expect(detailText(dyn1)).toContain("1 limit hit");
  });
});

describe("BFE-003 unresolved middleware guard", () => {
  it("returns the A1 not_assessed result, not a pass, when middleware is unresolved and nothing resolved", () => {
    const r = run({ coverage: { unresolvedMiddleware: true }, declarations: [] });
    expect(r).toMatchObject({ status: "not_assessed", confidence: "low" });
    expect(detailText(r)).toContain("unresolved aliases");
    expect(detailText(r)).not.toContain("nothing to limit");
  });
});

describe("BFE-003 invariants", () => {
  const proxies: Record<string, unknown>[] = [
    { present: "unknown" },
    { present: "yes", bodyLimitConfig: "not_supplied" },
  ];
  const risky = [
    decl({ limit: U }),
    decl({ kind: "multer", limit: D, multer: multer({ limitsObject: "absent" }) }),
    omit(decl({ kind: "custom-reader" }), "limit"),
  ];

  it("never fails behind an undescribed proxy", () => {
    for (const proxy of proxies) {
      for (const d of risky) {
        expect(run({ proxy, declarations: [d] }).status).not.toBe("fail");
      }
    }
  });

  it("never fails for custom-reader and never passes from unresolved declarations", () => {
    expect(run({ declarations: [risky[2]] }).status).not.toBe("fail");
    for (const scope of ["conditional", "unresolved"]) {
      expect(run({ declarations: [decl({ scope })] }).status).not.toBe("pass");
    }
    expect(run({ declarations: [decl({ limit: { state: "non-literal" } })] }).status).not.toBe(
      "pass",
    );
  });

  it("makes no security guarantee in text", () => {
    const r = run({ declarations: [decl()] });
    expect(`${r.remediation} ${detailText(r)}`).not.toMatch(
      /compliant|bug-free|\bis secure\b|DoS-proof/i,
    );
  });
});

describe("BFE-003 rule metadata and engine integration", () => {
  it("is registered, sorted by id, and produces one finding via the engine", () => {
    expect(builtinRules.map((r) => r.id)).toContain("BFE-003");
    const ids = builtinRules.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    const findings = runRules(
      createRegistry([bfe003]),
      build({ declarations: [decl({ limit: U })] }),
      { now: NOW },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "BFE-003",
      severity: "medium",
      status: "fail",
      confidence: "medium",
    });
    expect(findings[0]?.references).toHaveLength(4);
  });

  it("reports invalid input via the rule entry point", () => {
    const r = bfe003.evaluate({ input: { app: { expressAppFound: "CANARY999" } }, now: NOW });
    expect(r.status).toBe("not_assessed");
    expect(JSON.stringify(r)).not.toContain("CANARY999");
  });
});
