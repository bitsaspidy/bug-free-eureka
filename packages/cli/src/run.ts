import { realpath } from "node:fs/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { maskSecrets } from "@bug-free-eureka/core";
import { audit, FAIL_ON, FORMATS, type FailOn, type Format } from "./commands/audit.js";
import { init } from "./commands/init.js";
import { EXIT, UsageError, type ExitCode } from "./errors.js";
import type { CliIo } from "./io.js";
import { version } from "./version.js";

const NAME = "bug-free-eureka";

const HELP = `Usage: ${NAME} <command> [options]

Commands:
  init     Write a default ${NAME}.config.json (never overwrites without --force)
  audit    Run the built-in rules (BFE-001, BFE-003, BFE-005, BFE-006) on your evidence files

Options:
  -h, --help       Show help
  -V, --version    Show the version

Run "${NAME} <command> --help" for command options.
`;

const INIT_HELP = `Usage: ${NAME} init [options]

  --config <path>  Where to write the config (default: ${NAME}.config.json)
  --force          Overwrite an existing config file
  -h, --help       Show help
`;

const AUDIT_HELP = `Usage: ${NAME} audit [options]

  --config <path>         JSON config file (default: ${NAME}.config.json)
  --format <format>       text | json | sarif (default: text)
  --output <file>         Write the report to a file inside the project (atomic)
  --fail-on <severity>    critical | high | medium | low | info | none (default: high)
  --fail-on-unassessed    Also exit 1 when a rule could not be assessed
  --debug                 Timings and internal error stacks on stderr
  -h, --help              Show help

Exit codes:
  0  no failed finding at or above --fail-on
  1  failed findings at or above --fail-on (or not assessed, with --fail-on-unassessed)
  2  usage, config or path error
  3  internal error
`;

const COMMON = {
  help: { type: "boolean", short: "h" },
  config: { type: "string" },
} satisfies ParseArgsOptionsConfig;

const INIT_OPTIONS = { ...COMMON, force: { type: "boolean" } } satisfies ParseArgsOptionsConfig;

const AUDIT_OPTIONS = {
  ...COMMON,
  format: { type: "string" },
  output: { type: "string" },
  "fail-on": { type: "string" },
  "fail-on-unassessed": { type: "boolean" },
  debug: { type: "boolean" },
} satisfies ParseArgsOptionsConfig;

/** Flag name only (text before "="), restricted to safe characters: values are never echoed. */
function flagName(arg: string): string {
  return arg
    .split("=", 1)[0]!
    .replace(/[^A-Za-z0-9-]/g, "")
    .slice(0, 40);
}

function parse<T extends ParseArgsOptionsConfig>(args: string[], options: T, command: string) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const known = new Set(
        Object.keys(options)
          .map((k) => `--${k}`)
          .concat(["-h"]),
      );
      const unknown = args.find((a) => a.startsWith("-") && !known.has(a.split("=", 1)[0]!));
      throw new UsageError(
        `unknown option ${unknown === undefined ? "" : `"${flagName(unknown)}" `}(run "${NAME} ${command} --help")`,
      );
    }
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      throw new UsageError(`an option is missing its value (run "${NAME} ${command} --help")`);
    }
    if (code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") {
      throw new UsageError(`unexpected argument (run "${NAME} ${command} --help")`);
    }
    throw err;
  }
}

function choice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`${flag}: expected one of ${allowed.join(", ")}`);
}

async function dispatch(argv: string[], io: CliIo): Promise<ExitCode> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    io.stderr.write(HELP);
    return EXIT.USAGE;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    io.stdout.write(HELP);
    return EXIT.OK;
  }
  if (command === "-V" || command === "--version") {
    io.stdout.write(`${version}\n`);
    return EXIT.OK;
  }
  if (command !== "init" && command !== "audit") {
    throw new UsageError(`unknown command (run "${NAME} --help")`);
  }
  const root = await realpath(io.cwd).catch(() => {
    throw new UsageError("the working directory cannot be read");
  });

  if (command === "init") {
    const v = parse(rest, INIT_OPTIONS, command);
    if (v.help) {
      io.stdout.write(INIT_HELP);
      return EXIT.OK;
    }
    return init(
      root,
      { force: v.force ?? false, ...(v.config === undefined ? {} : { config: v.config }) },
      io,
    );
  }

  const v = parse(rest, AUDIT_OPTIONS, command);
  if (v.help) {
    io.stdout.write(AUDIT_HELP);
    return EXIT.OK;
  }
  return audit(
    root,
    {
      format: choice<Format>(v.format, FORMATS, "--format", "text"),
      failOn: choice<FailOn>(v["fail-on"], FAIL_ON, "--fail-on", "high"),
      failOnUnassessed: v["fail-on-unassessed"] ?? false,
      debug: v.debug ?? false,
      ...(v.config === undefined ? {} : { config: v.config }),
      ...(v.output === undefined ? {} : { output: v.output }),
    },
    io,
  );
}

/**
 * Runs the CLI and returns its exit code. Touches the outside world only through `io`
 * and the filesystem under `io.cwd`; never calls process.exit.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const args = [...argv];
  const debug = args.includes("--debug");
  try {
    return await dispatch(args, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`error: ${maskSecrets(err.message)}\n`);
      return EXIT.USAGE;
    }
    io.stderr.write(`internal error: this is a bug. Rerun with --debug and report it.\n`);
    if (debug && err instanceof Error && err.stack !== undefined) {
      // Stack frames only: the message line may quote input, so it is dropped.
      const frames = err.stack
        .split("\n")
        .filter((l) => /^\s+at /.test(l))
        .map((l) => maskSecrets(l));
      io.stderr.write(`${err.name}\n${frames.join("\n")}\n`);
    }
    return EXIT.INTERNAL;
  }
}
