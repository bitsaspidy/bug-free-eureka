import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, cli, exampleCopy } from "./helpers.js";

afterEach(cleanup);

// redaction-check skill canaries, placed in evidence values, nested keys and arrays.
const CANARY = /BFE_CANARY_[A-Z]+_[0-9a-f]{6}/;

const header = (name: string, value: string) => ({
  name,
  state: "set",
  value,
  layer: "app",
  scope: "global",
  origin: "source",
  location: "src/app.ts:3",
});

async function seed(dir: string): Promise<void> {
  const bfe001 = JSON.parse(await readFile(join(dir, "security", "bfe-001.json"), "utf8")) as {
    headers: unknown[];
  };
  bfe001.headers = [
    header(
      "content-security-policy",
      "default-src 'self'; report-uri https://x.example/?token=BFE_CANARY_TOKEN_7f3a91",
    ),
    header("authorization", "Bearer BFE_CANARY_TOKEN_7f3a91"),
    header("set-cookie", "sid=BFE_CANARY_COOKIE_9b11d5; HttpOnly"),
    header("x-api-key", "BFE_CANARY_ENV_a1b2c3"),
    header("strict-transport-security", "max-age=1; otp=BFE_CANARY_OTP_448120"),
  ];
  await writeFile(join(dir, "security", "bfe-001.json"), JSON.stringify(bfe001));
  // Invalid evidence for BFE-003: unknown keys and values carrying canaries.
  await writeFile(
    join(dir, "security", "bfe-003.json"),
    JSON.stringify({
      app: { PassWord: "BFE_CANARY_PASS_c02e44" },
      a: { b: { c: { d: { e: { refreshToken: ["BFE_CANARY_REFRESH_e5d7c2"] } } } } },
    }),
  );
  await writeFile(
    join(dir, "bug-free-eureka.config.json"),
    JSON.stringify({
      version: 1,
      rules: {
        "BFE-001": { evidence: "security/bfe-001.json" },
        "BFE-003": { evidence: "security/bfe-003.json" },
        "BFE-006": { evidence: "security/bfe-006.json" },
      },
    }),
  );
}

describe("no secrets in CLI output (redaction-check)", () => {
  it.each(["text", "json", "sarif"])("format %s: stdout, stderr and --output file", async (fmt) => {
    const dir = await exampleCopy();
    await seed(dir);
    for (const debug of [[], ["--debug"]]) {
      const r = await cli(["audit", "--format", fmt, ...debug], dir, { isTTY: true });
      expect(r.code).toBe(1);
      expect(r.stdout.length).toBeGreaterThan(100);
      expect(r.stdout).not.toMatch(CANARY);
      expect(r.stderr).not.toMatch(CANARY);
    }
    const f = await cli(["audit", "--format", fmt, "--output", `out/report.${fmt}`], dir);
    expect(f.stderr).not.toMatch(CANARY);
    expect(await readFile(join(dir, "out", `report.${fmt}`), "utf8")).not.toMatch(CANARY);
  });
});
