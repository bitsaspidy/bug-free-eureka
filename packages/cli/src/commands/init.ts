import { CONFIG_FILE, defaultConfig, describePath } from "../config.js";
import { EXIT, UsageError, type ExitCode } from "../errors.js";
import { exists, resolveInside, writeAtomic } from "../fs-safe.js";
import type { CliIo } from "../io.js";

export interface InitOptions {
  config?: string;
  force: boolean;
}

/** Writes the default JSON config. Never overwrites an existing file without `--force`. */
export async function init(root: string, opts: InitOptions, io: CliIo): Promise<ExitCode> {
  const label = opts.config === undefined ? CONFIG_FILE : "--config";
  const abs = await resolveInside(root, opts.config ?? CONFIG_FILE, label);
  if (!opts.force && (await exists(abs))) {
    throw new UsageError(`${label}: file already exists; rerun with --force to overwrite it`);
  }
  await writeAtomic(root, abs, `${JSON.stringify(defaultConfig(), null, 2)}\n`, label);
  const rel = describePath(root, abs);
  io.stderr.write(`Wrote ${rel}\n`);
  io.stderr.write(
    `Next: add evidence files under "rules", then run: npx bug-free-eureka audit${
      opts.config === undefined ? "" : ` --config ${rel}`
    }\n`,
  );
  return EXIT.OK;
}
