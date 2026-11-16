import { describe, expect, it } from "vitest";
import {
  buildReport,
  createRegistry,
  DuplicateRuleError,
  InputInvalidError,
  InvalidRuleError,
  InvalidRuleIdError,
  mask,
  maskSecrets,
  RuleRegistry,
  runRules,
  summarize,
  type Rule,
  type RuleResult,
  type SecurityFinding,
} from "../src/index.js";

const NOW = "2026-01-02T03:04:05.000Z";
const CANARY = "s3cr3t-canary-VALUE-123456";

function makeRule(id: string, evaluate: () => RuleResult, extra: Partial<Rule> = {}): Rule {
  return {
    id,
    version: "1.0.0",
    title: `Rule ${id}`,
    description: "desc",
    defaultSeverity: "medium",
    references: ["https://b.example", "https://a.example"],
    evaluate,
    ...extra,
  };
}

const ok = (status: RuleResult["status"]): RuleResult => ({
  status,
  confidence: "high",
  evidence: [
    { source: "z", detail: "later" },
    { source: "a", location: "x.js:1", detail: "first" },
    { source: "a", detail: "no location" },
  ],
  remediation: "fix it",
});

describe("runRules statuses", () => {
  it.each(["pass", "fail", "warning"] as const)("maps a %s result to a finding", (status) => {
    const [f] = runRules([makeRule("BFE-001", () => ok(status))], {}, { now: NOW });
    expect(f).toMatchObject({
      id: "BFE-001",
      ruleId: "BFE-001",
      ruleVersion: "1.0.0",
      status,
      severity: "medium",
      confidence: "high",
      remediation: "fix it",
    });
    expect(f?.references).toEqual(["https://a.example", "https://b.example"]);
    expect(f?.evidence.map((e) => e.detail)).toEqual(["no location", "first", "later"]);
  });

  it("keeps a not_assessed result from the rule", () => {
    const rule = makeRule("BFE-002", () => ({
      status: "not_assessed",
      confidence: "low",
      evidence: [{ source: "config", detail: "proxy config not supplied" }],
      remediation: "supply deployment config",
    }));
    const [f] = runRules([rule], {}, { now: NOW });
    expect(f?.status).toBe("not_assessed");
    expect(f?.evidence[0]?.detail).toBe("proxy config not supplied");
  });

  it("turns a throwing rule into not_assessed without leaking the error text", () => {
    const rule = makeRule("BFE-003", () => {
      throw new Error(`boom ${CANARY}`);
    });
    const findings = runRules([rule], {}, { now: NOW });
    expect(findings[0]).toMatchObject({ status: "not_assessed", confidence: "low" });
    expect(findings[0]?.evidence[0]?.detail).toContain("E_RULE_CRASH");
    expect(JSON.stringify(findings)).not.toContain(CANARY);
  });

  it("does not let one crash abort other rules", () => {
    const bad = makeRule("BFE-002", () => {
      throw new Error("x");
    });
    const good = makeRule("BFE-001", () => ok("pass"));
    const findings = runRules([bad, good], {}, { now: NOW });
    expect(findings.map((f) => [f.ruleId, f.status])).toEqual([
      ["BFE-001", "pass"],
      ["BFE-002", "not_assessed"],
    ]);
  });

  it.each([
    ["bad shape", () => ({ nope: true }) as unknown as RuleResult],
    [
      "empty evidence",
      () => ({ status: "pass", confidence: "high", evidence: [], remediation: "" }) as RuleResult,
    ],
    ["undefined", () => undefined as unknown as RuleResult],
  ])("turns an invalid rule result (%s) into not_assessed", (_name, fn) => {
    const [f] = runRules([makeRule("BFE-004", fn)], {}, { now: NOW });
    expect(f?.status).toBe("not_assessed");
    expect(f?.evidence[0]?.detail).toContain("invalid result");
  });

  it("passes input and the injected clock to rules", () => {
    let seen: unknown;
    const rule: Rule<{ a: number }> = {
      ...makeRule("BFE-005", () => ok("pass")),
      evaluate: (ctx) => {
        seen = [ctx.input.a, ctx.now];
        return ok("pass");
      },
    };
    runRules([rule], { a: 7 }, { now: new Date(NOW) });
    expect(seen).toEqual([7, NOW]);
  });
});

describe("determinism and ordering", () => {
  const rules = [
    makeRule("BFE-010", () => ok("fail"), { defaultSeverity: "low" }),
    makeRule("BFE-002", () => ok("pass"), { defaultSeverity: "high" }),
    makeRule("BFE-001", () => ok("warning")),
  ];

  it("orders findings by rule id regardless of registration order", () => {
    const a = runRules(rules, {}, { now: NOW }).map((f) => f.ruleId);
    const b = runRules([...rules].reverse(), {}, { now: NOW }).map((f) => f.ruleId);
    expect(a).toEqual(["BFE-001", "BFE-002", "BFE-010"]);
    expect(b).toEqual(a);
  });

  it("produces byte-identical reports for identical input", () => {
    const run = (): string =>
      JSON.stringify(
        buildReport({
          findings: runRules(rules, { x: 1 }, { now: NOW }),
          toolVersion: "0.0.0",
          generatedAt: NOW,
          scanScope: ["b", "a", "a"],
        }),
      );
    expect(run()).toBe(run());
  });
});

describe("registry", () => {
  it("rejects duplicate ids", () => {
    const r = makeRule("BFE-001", () => ok("pass"));
    expect(() => createRegistry([r, r])).toThrow(DuplicateRuleError);
    expect(() => runRules([r, r], {}, { now: NOW })).toThrowError(
      expect.objectContaining({ code: "E_RULE_DUPLICATE" }) as Error,
    );
  });

  it.each(["BFE-1", "BFE-0001", "bfe-001", "XYZ-001", "", "BFE-001\n"])(
    "rejects invalid id %j",
    (id) => {
      expect(() => new RuleRegistry().register(makeRule(id, () => ok("pass")))).toThrowError(
        expect.objectContaining({ code: "E_RULE_ID_INVALID" }) as Error,
      );
    },
  );

  it("rejects a non-string id with a typed error", () => {
    const bad = { ...makeRule("BFE-001", () => ok("pass")), id: 5 } as unknown as Rule;
    expect(() => createRegistry([bad])).toThrow(InvalidRuleIdError);
  });

  it("rejects malformed rule definitions without echoing values", () => {
    const bad = { ...makeRule("BFE-001", () => ok("pass")), version: CANARY } as Rule;
    try {
      createRegistry([bad]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidRuleError);
      expect((e as Error).message).not.toContain(CANARY);
      expect((e as { code: string }).code).toBe("E_RULE_INVALID");
    }
  });

  it("rejects a rule without an evaluate function", () => {
    const bad = { ...makeRule("BFE-001", () => ok("pass")), evaluate: 1 } as unknown as Rule;
    expect(() => createRegistry([bad])).toThrow(InvalidRuleError);
  });

  it("supports get and sorted list, and runRules accepts a registry", () => {
    const reg = new RuleRegistry()
      .register(makeRule("BFE-002", () => ok("pass")))
      .register(makeRule("BFE-001", () => ok("pass")));
    expect(reg.get("BFE-001")?.id).toBe("BFE-001");
    expect(reg.get("BFE-999")).toBeUndefined();
    expect(reg.list().map((r) => r.id)).toEqual(["BFE-001", "BFE-002"]);
    expect(runRules(reg, {}, { now: NOW })).toHaveLength(2);
  });

  it("rejects invalid run options with a typed error", () => {
    for (const now of ["yesterday", new Date("nope"), 5, undefined]) {
      expect(() => runRules([], {}, { now } as never)).toThrow(InputInvalidError);
    }
    expect(() => runRules([], {}, { now: NOW, extra: 1 } as never)).toThrow(InputInvalidError);
  });
});

describe("buildReport and summary", () => {
  const f = (status: SecurityFinding["status"], n: number): SecurityFinding => ({
    id: `BFE-00${n}`,
    ruleId: `BFE-00${n}`,
    ruleVersion: "1.0.0",
    title: "t",
    description: "d",
    severity: "low",
    confidence: "low",
    status,
    evidence: [{ source: "s", detail: "d" }],
    remediation: "r",
    references: [],
  });

  it("counts every status", () => {
    const findings = [
      f("pass", 1),
      f("pass", 2),
      f("fail", 3),
      f("warning", 4),
      f("not_assessed", 5),
      f("not_assessed", 6),
    ];
    expect(summarize(findings)).toEqual({ passed: 2, failed: 1, warnings: 1, notAssessed: 2 });
    const report = buildReport({
      findings,
      toolVersion: "1.2.3",
      generatedAt: new Date(NOW),
      scanScope: ["src", "app"],
    });
    expect(report).toMatchObject({
      schemaVersion: "1.0",
      toolVersion: "1.2.3",
      generatedAt: NOW,
      scanScope: ["app", "src"],
      summary: { passed: 2, failed: 1, warnings: 1, notAssessed: 2 },
    });
    expect(report.findings).toHaveLength(6);
  });

  it("handles an empty report", () => {
    expect(
      buildReport({ findings: [], toolVersion: "0", generatedAt: NOW, scanScope: [] }).summary,
    ).toEqual({ passed: 0, failed: 0, warnings: 0, notAssessed: 0 });
  });

  it("rejects invalid report input with a typed error", () => {
    expect(() =>
      buildReport({
        findings: [{ ...f("pass", 1), ruleId: "nope" }],
        toolVersion: "1",
        generatedAt: NOW,
        scanScope: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "E_INPUT_INVALID" }) as Error);
    expect(() =>
      buildReport({ findings: [], toolVersion: "", generatedAt: "bad", scanScope: [] }),
    ).toThrow(InputInvalidError);
  });
});

describe("masking", () => {
  it("mask never reveals the value or its length", () => {
    expect(mask(CANARY)).toBe("****");
    expect(mask()).toBe("****");
  });

  it.each([
    `password=${CANARY}`,
    `"apiKey": "${CANARY}"`,
    `Authorization: Bearer ${CANARY}`,
    `session_secret: '${CANARY}'`,
    `Cookie: sid=${CANARY}`,
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz",
    "key sk-abcdefghijklmnop1234567890",
    "id AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN RSA PRIVATE KEY-----",
  ])("masks secret-looking text: %s", (text) => {
    const out = maskSecrets(text);
    expect(out).toContain("****");
    expect(out).not.toContain(CANARY);
    expect(out).not.toMatch(/eyJhbGci|AKIAABCD|sk-abcdef|BEGIN RSA/);
  });

  it("leaves harmless text alone and caps huge input quickly", () => {
    expect(maskSecrets("string literal assigned to session secret (value masked)")).toBe(
      "string literal assigned to session secret (value masked)",
    );
    const huge = `a${"=".repeat(50_000)}`;
    expect(maskSecrets(huge).length).toBeLessThan(10_100);
  });

  it("masks evidence detail, location, source and remediation emitted by rules", () => {
    const rule = makeRule("BFE-001", () => ({
      status: "fail",
      confidence: "high",
      evidence: [
        {
          source: `token=${CANARY}`,
          location: `f.js?secret=${CANARY}`,
          detail: `password: ${CANARY}`,
        },
      ],
      remediation: `rotate api_key=${CANARY}`,
    }));
    const findings = runRules([rule], {}, { now: NOW });
    expect(JSON.stringify(findings)).not.toContain(CANARY);
    expect(findings[0]?.evidence[0]?.detail).toBe("password: ****");
  });
});

describe("evidence ordering", () => {
  it("sorts by source, then location, then detail", () => {
    const rule = makeRule("BFE-001", () => ({
      status: "fail",
      confidence: "high",
      evidence: [
        { source: "a", location: "b", detail: "2" },
        { source: "a", location: "b", detail: "1" },
        { source: "a", location: "a", detail: "9" },
      ],
      remediation: "r",
    }));
    const [f] = runRules([rule], {}, { now: NOW });
    expect(f?.evidence.map((e) => `${e.location}${e.detail}`)).toEqual(["a9", "b1", "b2"]);
  });
});

describe("hostile rule results", () => {
  it("handles a throwing getter on the result without leaking its text", () => {
    const rule = makeRule("BFE-001", () => {
      const r = { confidence: "high", evidence: [], remediation: "" };
      Object.defineProperty(r, "status", {
        enumerable: true,
        get() {
          throw new Error(`getter ${CANARY}`);
        },
      });
      return r as unknown as RuleResult;
    });
    const findings = runRules([rule], {}, { now: NOW });
    expect(findings[0]?.status).toBe("not_assessed");
    expect(JSON.stringify(findings)).not.toContain(CANARY);
  });

  it("handles a throwing Proxy result", () => {
    const rule = makeRule("BFE-001", () => {
      return new Proxy(
        {},
        {
          get() {
            throw new Error(`proxy ${CANARY}`);
          },
          ownKeys() {
            throw new Error(`proxy ${CANARY}`);
          },
        },
      ) as RuleResult;
    });
    const findings = runRules([rule], {}, { now: NOW });
    expect(findings[0]?.status).toBe("not_assessed");
    expect(JSON.stringify(findings)).not.toContain(CANARY);
  });

  it("neutralises an async rule and its later rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const rule = makeRule(
        "BFE-001",
        () => Promise.reject(new Error(`async ${CANARY}`)) as unknown as RuleResult,
      );
      const findings = runRules([rule], {}, { now: NOW });
      expect(findings[0]?.status).toBe("not_assessed");
      expect(findings[0]?.evidence[0]?.detail).toContain("synchronous");
      expect(JSON.stringify(findings)).not.toContain(CANARY);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("handles a thenable whose then throws", () => {
    const rule = makeRule("BFE-001", () => {
      return {
        then() {
          throw new Error(`then ${CANARY}`);
        },
      } as unknown as RuleResult;
    });
    const findings = runRules([rule], {}, { now: NOW });
    expect(findings[0]?.status).toBe("not_assessed");
    expect(JSON.stringify(findings)).not.toContain(CANARY);
  });
});

describe("report masking", () => {
  it("masks findings and scope passed to buildReport", () => {
    const report = buildReport({
      findings: [
        {
          id: "BFE-001",
          ruleId: "BFE-001",
          ruleVersion: "1.0.0",
          title: `t password=${CANARY}`,
          description: `d token=${CANARY}`,
          severity: "low",
          confidence: "low",
          status: "fail",
          evidence: [
            {
              source: `s secret=${CANARY}`,
              location: `l token=${CANARY}`,
              detail: `password=${CANARY}`,
            },
            { source: "plain", detail: "no location" },
          ],
          remediation: `r api_key=${CANARY}`,
          references: [`https://x.example/?token=${CANARY}`],
        },
      ],
      toolVersion: "1",
      generatedAt: NOW,
      scanScope: [`dir?token=${CANARY}`],
    });
    expect(JSON.stringify(report)).not.toContain(CANARY);
  });
});

describe("mask coverage gaps", () => {
  it.each([
    `Cookie: a=1; b=${CANARY}; c=3`,
    `Set-Cookie: sid=${CANARY}; HttpOnly`,
    `postgres://admin:${CANARY}@db.example/app`,
    `-----BEGIN PRIVATE KEY-----\n${CANARY}\nmore\n-----END PRIVATE KEY-----`,
    `-----BEGIN EC PRIVATE KEY-----\n${CANARY}`,
    `MY_VERY_LONG_PREFIX_NAME_FOR_THE_DATABASE_PASSWORD=${CANARY}`,
    `X_PASSWORD_WITH_AN_EXTREMELY_LONG_SUFFIX_${"A".repeat(60)}=${CANARY}`,
    `pwd=${CANARY}`,
    `password=${encodeURIComponent(`${CANARY} p@ss/w&rd`)}`,
    `password="${CANARY} with spaces"`,
    `password='${CANARY} with spaces'`,
    `{"password":"${CANARY} with \\"quote\\" and spaces"}`,
    `{\\"password\\":\\"${CANARY} spaced\\"}`,
    `password="${CANARY} unterminated`,
  ])("masks %j", (text) => {
    const out = maskSecrets(text);
    expect(out).toContain("****");
    expect(out).not.toContain(CANARY);
    expect(out).not.toMatch(/spaces|spaced|unterminated|with \\"quote|more\b|p@ss/);
  });

  it("processes 100 KB of adversarial input in linear time", () => {
    const inputs = [
      "a".repeat(100_000),
      "password=".repeat(12_000),
      `password="${"\\".repeat(100_000)}`,
      `-----BEGIN PRIVATE KEY-----`.repeat(5_000),
      `${"x".repeat(50_000)}token${"-".repeat(50_000)}`,
      "://".repeat(30_000),
      "Bearer ".repeat(15_000),
    ];
    const start = performance.now();
    for (const input of inputs) maskSecrets(input);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it("truncates, masks and quotes a hostile rule id in the error", () => {
    const hostile = `password=${CANARY}\n${"x".repeat(100)}`;
    try {
      new RuleRegistry().register(makeRule(hostile, () => ok("pass")));
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(CANARY);
      expect(msg).not.toContain("\n");
      expect(msg.length).toBeLessThan(200);
    }
  });
});

describe("evidence ordering with optional location", () => {
  it("orders located and unlocated evidence deterministically", () => {
    const items = [
      { source: "a", location: "x", detail: "1" },
      { source: "a", detail: "2" },
      { source: "a", location: "y", detail: "3" },
    ];
    const run = (list: typeof items): string[] => {
      const rule = makeRule("BFE-001", () => ({
        status: "fail",
        confidence: "high",
        evidence: list,
        remediation: "r",
      }));
      return (runRules([rule], {}, { now: NOW })[0]?.evidence ?? []).map((e) => e.detail);
    };
    expect(run(items)).toEqual(["2", "1", "3"]);
    expect(run([...items].reverse())).toEqual(["2", "1", "3"]);
  });
});
