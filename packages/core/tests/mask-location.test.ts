import { describe, expect, it } from "vitest";
import {
  bfe005,
  buildReport,
  createRegistry,
  maskLocation,
  maskSecrets,
  runRules,
} from "../src/index.js";

const NOW = "2026-01-02T03:04:05.000Z";
const LEAK = /BFE_CANARY_[A-Z]+_[0-9a-f]{6}/;

const loggerAt = (location: string) => ({
  library: "pino",
  kind: "request",
  scope: "global",
  location,
  emits: { requestHeaders: "yes", responseHeaders: "no", requestBody: "no", query: "no" },
  redaction: { state: "none" },
});

describe("evidence locations keep their line numbers (WO-005 review)", () => {
  it.each(["src/auth.ts:12", "src/signup.ts:3", "lib/session-store.js:40", "src/otp/code.ts:7"])(
    "%s survives the engine and the report",
    (location) => {
      const input = {
        app: { expressAppFound: true },
        loggers: [loggerAt(location)],
        coverage: { complete: true, limitsHit: [] },
      };
      const findings = runRules(createRegistry([bfe005]), input, { now: NOW });
      expect(findings[0]?.evidence[0]?.location).toBe(location);
      const report = buildReport({
        findings,
        toolVersion: "0.0.0",
        generatedAt: NOW,
        scanScope: ["src"],
      });
      expect(report.findings[0]?.evidence[0]?.location).toBe(location);
    },
  );

  it("still masks unsafe locations", () => {
    expect(maskLocation("token=BFE_CANARY_TOKEN_7f3a91")).not.toMatch(LEAK);
    expect(maskLocation("/abs/auth.ts:1 code=BFE_CANARY_OTP_448120")).not.toMatch(LEAK);
  });
});

describe("maskSecrets short keys need a word start", () => {
  it.each(["design: wide", "signal=1", "encoded=abc", "author: bob", "assign=x", "barcode=123"])(
    "leaves %s alone",
    (text) => expect(maskSecrets(text)).toBe(text),
  );

  it.each([
    "code=BFE_CANARY_OTP_448120",
    "/cb?sig=BFE_CANARY_TOKEN_7f3a91",
    "signature: BFE_CANARY_TOKEN_7f3a91",
    "X_DB_AUTH=BFE_CANARY_ENV_a1b2c3",
    "x-otp: BFE_CANARY_OTP_448120",
    "DB_PASSWORD=BFE_CANARY_PASS_c02e44",
    "xAuthToken=BFE_CANARY_TOKEN_7f3a91",
    "session=BFE_CANARY_COOKIE_9b11d5",
  ])("masks %s", (text) => expect(maskSecrets(text)).not.toMatch(LEAK));
});
