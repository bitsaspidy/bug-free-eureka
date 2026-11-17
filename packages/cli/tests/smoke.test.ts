import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, exampleCopy } from "./helpers.js";

afterEach(cleanup);

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

function exec(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

// The built bin, run in a clean copy of an external example project (outside the repo).
// The example has a package.json postinstall and src/app.ts that throw if executed.
describe("built bin against the clean external example project", () => {
  it("audit --format json exits 1 with a parseable report on stdout", async () => {
    const dir = await exampleCopy();
    const r = await exec(["audit", "--format", "json"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    const report = JSON.parse(r.stdout) as { summary: Record<string, number> };
    expect(report.summary).toEqual({ passed: 0, failed: 2, warnings: 0, notAssessed: 1 });
  });

  it("audit --fail-on critical --format sarif --output exits 0 and writes SARIF", async () => {
    const dir = await exampleCopy();
    const r = await exec(
      ["audit", "--fail-on", "critical", "--format", "sarif", "--output", "bfe.sarif"],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const sarif = JSON.parse(await readFile(join(dir, "bfe.sarif"), "utf8")) as { version: string };
    expect(sarif.version).toBe("2.1.0");
  });

  it("usage errors exit 2", async () => {
    const dir = await exampleCopy();
    expect((await exec(["audit", "--nope"], dir)).code).toBe(2);
  });
});
