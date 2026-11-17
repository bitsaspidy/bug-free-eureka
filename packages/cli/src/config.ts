import { z } from "zod";
import { UsageError } from "./errors.js";
import { exists, parseJson, readSmallFile, resolveInside, toPosixRelative } from "./fs-safe.js";

export const CONFIG_FILE = "bug-free-eureka.config.json";
export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/bitsaspidy/bug-free-eureka/main/packages/cli/schema/config.schema.json";

/** Rule ids the CLI knows. Must match core's `builtinRules` (checked by a test). */
export const RULE_IDS = ["BFE-001", "BFE-003", "BFE-005", "BFE-006"] as const;
export type RuleId = (typeof RULE_IDS)[number];

const ruleConfigSchema = z.strictObject({
  enabled: z.boolean().optional().describe("Run this rule. Default: true."),
  evidence: z
    .string()
    .min(1)
    .max(1000)
    .regex(/\.json$/i)
    .optional()
    .describe("Path, relative to the project root, of a JSON file with this rule's input."),
});

export const configSchema = z.strictObject({
  $schema: z.string().max(2000).optional(),
  version: z.literal(1),
  rules: z
    .strictObject({
      "BFE-001": ruleConfigSchema.optional(),
      "BFE-003": ruleConfigSchema.optional(),
      "BFE-005": ruleConfigSchema.optional(),
      "BFE-006": ruleConfigSchema.optional(),
    })
    .default({}),
});

export type CliConfig = z.infer<typeof configSchema>;

export interface LoadedConfig {
  config: CliConfig;
  /** Absolute path of the file read, or undefined when no config file exists. */
  path?: string;
}

export function defaultConfig(): CliConfig {
  return {
    $schema: CONFIG_SCHEMA_URL,
    version: 1,
    rules: Object.fromEntries(RULE_IDS.map((id) => [id, { enabled: true }])),
  };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `expected ${issue.expected}`;
    case "unrecognized_keys":
      return "contains an unknown key";
    case "invalid_value":
      return "has an unsupported value";
    case "invalid_format":
      return "expected a relative path to a .json file";
    case "too_big":
    case "too_small":
      return "is too long or empty";
    default:
      return "is invalid";
  }
}

/** Formats Zod issues as `config.rules.BFE-003.evidence: <expectation>`: paths only, never values. */
export function formatIssues(prefix: string, error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => {
      const path = issue.path.map((p) => String(p)).join(".");
      return `${prefix}${path ? `.${path}` : ""}: ${describeIssue(issue)}`;
    })
    .join("\n");
}

export async function loadConfig(root: string, flag: string | undefined): Promise<LoadedConfig> {
  const label = flag === undefined ? "config" : "--config";
  const abs = await resolveInside(root, flag ?? CONFIG_FILE, label);
  if (flag === undefined && !(await exists(abs)))
    return { config: configSchema.parse({ version: 1 }) };
  const raw = parseJson(await readSmallFile(abs, label), label);
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new UsageError(formatIssues("config", parsed.error));
  return { config: parsed.data, path: abs };
}

export function describePath(root: string, abs: string): string {
  return toPosixRelative(root, abs);
}
