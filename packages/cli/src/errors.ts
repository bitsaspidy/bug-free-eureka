/** Documented exit codes. Keep in sync with packages/cli/README.md. */
export const EXIT = {
  /** Success: no finding at or above `--fail-on`. */
  OK: 0,
  /** At least one finding at or above `--fail-on` (or not assessed, with `--fail-on-unassessed`). */
  FINDINGS: 1,
  /** Usage or config error: bad flag, invalid config or evidence, path outside the project. */
  USAGE: 2,
  /** Internal error (a bug). */
  INTERNAL: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * A usage, config or path problem the user can fix. Messages are written by the CLI
 * and never include user-supplied values (paths, config values, flag values).
 */
export class UsageError extends Error {
  override readonly name = "UsageError";
}
