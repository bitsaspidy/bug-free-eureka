import { z } from "zod";

export const RULE_ID_PATTERN = /^BFE-\d{3}$/;

export const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export const statusSchema = z.enum(["pass", "fail", "warning", "not_assessed"]);
export const confidenceSchema = z.enum(["high", "medium", "low"]);

export const evidenceSchema = z.strictObject({
  source: z.string().min(1),
  location: z.string().exactOptional(),
  detail: z.string().min(1),
});

export const ruleResultSchema = z.strictObject({
  status: statusSchema,
  confidence: confidenceSchema,
  evidence: z.array(evidenceSchema).min(1),
  remediation: z.string(),
});

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const ruleShapeSchema = z.object({
  id: z.string(),
  version: z.string().regex(SEMVER),
  title: z.string().min(1),
  description: z.string(),
  defaultSeverity: severitySchema,
  references: z.array(z.string()),
  evaluate: z.custom<unknown>((v) => typeof v === "function"),
});

export const nowSchema = z
  .union([z.date().refine((d) => !Number.isNaN(d.getTime()), "invalid date"), z.iso.datetime()])
  .transform((v) => (typeof v === "string" ? new Date(v) : v).toISOString());

export const runOptionsSchema = z.strictObject({ now: nowSchema });

export const findingSchema = z.strictObject({
  id: z.string().min(1),
  ruleId: z.string().regex(RULE_ID_PATTERN),
  ruleVersion: z.string().min(1),
  title: z.string(),
  description: z.string(),
  severity: severitySchema,
  confidence: confidenceSchema,
  status: statusSchema,
  evidence: z.array(evidenceSchema),
  remediation: z.string(),
  references: z.array(z.string()),
});

export const reportOptionsSchema = z.strictObject({
  findings: z.array(findingSchema),
  toolVersion: z.string().min(1),
  generatedAt: nowSchema,
  scanScope: z.array(z.string()),
});

/** Paths only, never values (values may be secrets). */
export function issuePaths(error: z.ZodError): string {
  const paths = error.issues.map((i) => (i.path.length ? i.path.join(".") : "(root)"));
  return [...new Set(paths)].sort().slice(0, 5).join(", ");
}
