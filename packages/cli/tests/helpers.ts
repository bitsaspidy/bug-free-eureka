import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.js";
import type { CliIo } from "../src/io.js";

export const EXAMPLE_APP = fileURLToPath(new URL("./fixtures/example-app/", import.meta.url));
export const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export async function cli(
  argv: string[],
  cwd: string,
  extra: Partial<Omit<CliIo, "stdout" | "stderr" | "cwd">> = {},
): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    cwd,
    env: {},
    isTTY: false,
    now: () => FIXED_NOW,
    ...extra,
  });
  return { code, stdout, stderr };
}

const dirs: string[] = [];

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bfe-cli-"));
  dirs.push(dir);
  return dir;
}

/** A fresh copy of the example project in a temp dir, outside the repository. */
export async function exampleCopy(): Promise<string> {
  const dir = await tempDir();
  await cp(EXAMPLE_APP, dir, { recursive: true });
  return dir;
}

export async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}
