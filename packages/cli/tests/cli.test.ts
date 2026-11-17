import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { builtinRules } from "@bug-free-eureka/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { configSchema, RULE_IDS } from "../src/config.js";
import { cleanup, cli, exampleCopy, tempDir } from "./helpers.js";

afterEach(cleanup);

const ESC = "\u001b[";

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  kind: string;
  level: string;
  message: { text: string };
  locations: {
    physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } };
  }[];
  partialFingerprints: Record<string, string>;
}
interface Sarif {
  version: string;
  runs: { tool: { driver: { rules: { id: string }[] } }; results: SarifResult[] }[];
}

describe("top level", () => {
  it("--help and --version exit 0 on stdout", async () => {
    const dir = await tempDir();
    const help = await cli(["--help"], dir);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/Usage: bug-free-eureka/);
    const ver = await cli(["--version"], dir);
    expect(ver).toEqual({ code: 0, stdout: "0.0.0\n", stderr: "" });
    expect((await cli(["audit", "--help"], dir)).stdout).toMatch(/Exit codes/);
    expect((await cli(["init", "-h"], dir)).code).toBe(0);
  });

  it("no command, unknown command, unknown option or bad value exit 2", async () => {
    const dir = await tempDir();
    const none = await cli([], dir);
    expect(none.code).toBe(2);
    expect(none.stdout).toBe("");
    expect((await cli(["scan"], dir)).code).toBe(2);
    expect((await cli(["audit", "extra"], dir)).code).toBe(2);
    expect((await cli(["audit", "--output"], dir)).code).toBe(2);
    const fmt = await cli(["audit", "--format", "xml"], dir);
    expect(fmt.code).toBe(2);
    expect(fmt.stderr).toContain("--format: expected one of text, json, sarif");
    expect((await cli(["audit", "--fail-on", "severe"], dir)).code).toBe(2);
  });

  it("does not echo option values in errors", async () => {
    const dir = await tempDir();
    const r = await cli(["audit", "--token=BFE_CANARY_TOKEN_7f3a91"], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown option "--token"');
    expect(r.stderr + r.stdout).not.toMatch(/BFE_CANARY_/);
  });
});

describe("init", () => {
  it("writes a valid default config and never overwrites without --force", async () => {
    const dir = await tempDir();
    const first = await cli(["init"], dir);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("");
    expect(first.stderr).toMatch(/npx bug-free-eureka audit/);
    const file = join(dir, "bug-free-eureka.config.json");
    const parsed = configSchema.parse(JSON.parse(await readFile(file, "utf8")));
    expect(Object.keys(parsed.rules)).toEqual([...RULE_IDS]);

    await writeFile(file, '{"version":1,"rules":{}}\n');
    const second = await cli(["init"], dir);
    expect(second.code).toBe(2);
    expect(second.stderr).toMatch(/already exists; rerun with --force/);
    expect(await readFile(file, "utf8")).toBe('{"version":1,"rules":{}}\n');

    expect((await cli(["init", "--force"], dir)).code).toBe(0);
    expect(await readFile(file, "utf8")).toContain('"BFE-006"');
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes to --config inside the project and refuses paths outside it", async () => {
    const dir = await tempDir();
    expect((await cli(["init", "--config", "conf/bfe.json"], dir)).code).toBe(0);
    expect(await readFile(join(dir, "conf", "bfe.json"), "utf8")).toContain('"version": 1');
    const out = await cli(["init", "--config", "../escape.json"], dir);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("outside the project directory");
  });
});

describe("audit exit codes", () => {
  it("0: no config, every rule not assessed (not a pass), hint on stderr", async () => {
    const dir = await tempDir();
    const r = await cli(["audit"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/0 failed, 0 warnings, 4 not assessed, 0 passed/);
    expect(r.stdout).toMatch(/NOT ASSESSED \(not a pass\) BFE-001/);
    expect(r.stderr).toMatch(/No bug-free-eureka.config.json found/);
  });

  it("1: failed findings at or above --fail-on; thresholds respected", async () => {
    const dir = await exampleCopy();
    expect((await cli(["audit"], dir)).code).toBe(1); // BFE-006 is high, default --fail-on high
    expect((await cli(["audit", "--fail-on", "critical"], dir)).code).toBe(0);
    expect((await cli(["audit", "--fail-on", "medium"], dir)).code).toBe(1);
    expect((await cli(["audit", "--fail-on", "none"], dir)).code).toBe(0);
  });

  it("1: not assessed only fails with --fail-on-unassessed", async () => {
    const dir = await tempDir();
    expect((await cli(["audit", "--fail-on", "info"], dir)).code).toBe(0);
    expect((await cli(["audit", "--fail-on-unassessed"], dir)).code).toBe(1);
  });

  it("2: invalid config reports paths, never values or unknown key names", async () => {
    const dir = await tempDir();
    const file = join(dir, "bug-free-eureka.config.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        rules: { "BFE-003": { evidence: "BFE_CANARY_PASS_c02e44.txt", BFE_CANARY_OTP_448120: 1 } },
      }),
    );
    const r = await cli(["audit"], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("config.version:");
    expect(r.stderr).toContain("config.rules.BFE-003.evidence:");
    expect(r.stderr).toContain("config.rules.BFE-003: contains an unknown key");
    expect(r.stderr + r.stdout).not.toMatch(/BFE_CANARY_/);

    await writeFile(file, '{"version": 1, "token": BFE_CANARY_TOKEN_7f3a91}');
    const bad = await cli(["audit"], dir);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toBe("error: config: not valid JSON\n");
    expect((await cli(["audit", "--config", "missing.json"], dir)).code).toBe(2);
  });

  it("2: evidence paths must stay inside the project and be regular .json files", async () => {
    const dir = await tempDir();
    const file = join(dir, "bug-free-eureka.config.json");
    const cfg = (evidence: string) =>
      writeFile(file, JSON.stringify({ version: 1, rules: { "BFE-001": { evidence } } }));
    await cfg("../outside.json");
    const r = await cli(["audit"], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      "config.rules.BFE-001.evidence: path is outside the project directory",
    );
    await cfg("missing.json");
    expect((await cli(["audit"], dir)).stderr).toMatch(/file not found/);
    await mkdir(join(dir, "dir.json"));
    await cfg("dir.json");
    expect((await cli(["audit"], dir)).stderr).toMatch(/not a regular file/);
    await cfg("src/app.ts");
    expect((await cli(["audit"], dir)).code).toBe(2);
  });

  it("2: a symlink that escapes the project is refused", async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, "e.json"), "{}");
    try {
      await symlink(join(outside, "e.json"), join(dir, "e.json"));
    } catch {
      // Windows without Developer Mode cannot create symlinks; the lexical check is covered above.
      return;
    }
    await writeFile(
      join(dir, "bug-free-eureka.config.json"),
      JSON.stringify({ version: 1, rules: { "BFE-001": { evidence: "e.json" } } }),
    );
    const r = await cli(["audit"], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/outside the project directory/);
  });

  it("3: internal errors exit 3 with a hint; --debug shows frames but not the message", async () => {
    const dir = await tempDir();
    const boom = () => {
      throw new Error("DB_PASSWORD=BFE_CANARY_ENV_a1b2c3");
    };
    const r = await cli(["audit"], dir, { now: boom });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/internal error: this is a bug. Rerun with --debug/);
    const d = await cli(["audit", "--debug"], dir, { now: boom });
    expect(d.code).toBe(3);
    expect(d.stderr).toMatch(/\n\s+at /);
    expect(d.stderr + d.stdout).not.toMatch(/BFE_CANARY_/);
  });
});

describe("audit output", () => {
  it("json: stdout is only the SecurityReport", async () => {
    const dir = await exampleCopy();
    const r = await cli(["audit", "--format", "json"], dir);
    const report = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      schemaVersion: "1.0",
      toolVersion: "0.0.0",
      generatedAt: "2026-01-02T03:04:05.000Z",
      scanScope: ["bug-free-eureka.config.json", "security/bfe-001.json", "security/bfe-006.json"],
      summary: { passed: 0, failed: 2, warnings: 0, notAssessed: 1 },
    });
    expect(r.stderr).toBe("");
  });

  it("sarif: 2.1.0, not_assessed is review/none, every result has a stable location", async () => {
    const dir = await exampleCopy();
    const a = await cli(["audit", "--format", "sarif"], dir);
    const b = await cli(["audit", "--format", "sarif"], dir);
    expect(a.stdout).toBe(b.stdout);
    const sarif = JSON.parse(a.stdout) as Sarif;
    expect(sarif.version).toBe("2.1.0");
    const run = sarif.runs[0]!;
    const byRule = Object.fromEntries(run.results.map((x) => [x.ruleId, x]));
    expect(byRule["BFE-003"]).toMatchObject({ kind: "review", level: "none" });
    expect(byRule["BFE-003"]!.message.text).toMatch(/^Not assessed \(this is not a pass\)/);
    expect(byRule["BFE-006"]).toMatchObject({ kind: "fail", level: "error" });
    expect(byRule["BFE-006"]!.locations[0]!.physicalLocation).toMatchObject({
      artifactLocation: { uri: "src/app.ts" },
      region: { startLine: 7 },
    });
    expect(byRule["BFE-001"]).toMatchObject({ kind: "fail", level: "warning" });
    expect(byRule["BFE-001"]!.locations[0]!.physicalLocation.artifactLocation.uri).toBe(
      "security/bfe-001.json",
    );
    expect(byRule["BFE-003"]!.locations[0]!.physicalLocation.artifactLocation.uri).toBe(
      "bug-free-eureka.config.json",
    );
    for (const res of run.results) {
      expect(res.kind).not.toBe("pass");
      expect(run.tool.driver.rules[res.ruleIndex]!.id).toBe(res.ruleId);
      expect(res.partialFingerprints["bfe/v1"]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(run.results.map((x) => x.ruleId)).not.toContain("BFE-005"); // disabled in config
  });

  it("colour only on a TTY, never with NO_COLOR, never in json", async () => {
    const dir = await tempDir();
    expect((await cli(["audit"], dir, { isTTY: true })).stdout).toContain(ESC);
    expect((await cli(["audit"], dir, { isTTY: false })).stdout).not.toContain(ESC);
    expect(
      (await cli(["audit"], dir, { isTTY: true, env: { NO_COLOR: "1" } })).stdout,
    ).not.toContain(ESC);
    expect((await cli(["audit"], dir, { env: { FORCE_COLOR: "1" } })).stdout).toContain(ESC);
    expect((await cli(["audit", "--format", "json"], dir, { isTTY: true })).stdout).not.toContain(
      ESC,
    );
  });

  it("--output writes atomically inside the project and leaves stdout empty", async () => {
    const dir = await exampleCopy();
    const r = await cli(["audit", "--format", "sarif", "--output", "reports/bfe.sarif"], dir, {
      isTTY: true,
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Wrote reports/bfe.sarif\n");
    const sarif = JSON.parse(await readFile(join(dir, "reports", "bfe.sarif"), "utf8")) as Sarif;
    expect(sarif.version).toBe("2.1.0");
    expect(await readdir(join(dir, "reports"))).toEqual(["bfe.sarif"]);

    const text = await cli(["audit", "--output", "report.txt"], dir, { isTTY: true });
    expect(await readFile(join(dir, "report.txt"), "utf8")).not.toContain(ESC);
    expect(text.code).toBe(1);

    expect((await cli(["audit", "--output", "../x.json"], dir)).code).toBe(2);
    expect((await cli(["audit", "--output", "reports"], dir)).stderr).toMatch(/is a directory/);
  });
});

describe("contracts", () => {
  it("knows exactly core's built-in rules", () => {
    expect(builtinRules.map((r) => r.id)).toEqual([...RULE_IDS]);
  });

  it("schema/config.schema.json matches the Zod config schema", async () => {
    const file = new URL("../schema/config.schema.json", import.meta.url);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(
      z.toJSONSchema(configSchema, { io: "input" }),
    );
  });
});
