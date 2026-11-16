import type { SecurityFinding, SecurityReport } from "../types/index.js";
import { InputInvalidError } from "../engine/errors.js";
import { issuePaths, reportOptionsSchema } from "../engine/schemas.js";
import { maskSecrets } from "../engine/mask.js";
import { compare } from "../engine/sort.js";

export interface BuildReportOptions {
  findings: readonly SecurityFinding[];
  toolVersion: string;
  /** Injected clock (Date or ISO-8601 UTC string). Never Date.now(). */
  generatedAt: Date | string;
  /** POSIX-relative paths or descriptions of what was scanned. */
  scanScope: readonly string[];
}

export function summarize(findings: readonly SecurityFinding[]): SecurityReport["summary"] {
  const summary = { passed: 0, failed: 0, warnings: 0, notAssessed: 0 };
  for (const f of findings) {
    if (f.status === "pass") summary.passed++;
    else if (f.status === "fail") summary.failed++;
    else if (f.status === "warning") summary.warnings++;
    else summary.notAssessed++;
  }
  return summary;
}

function maskFinding(f: SecurityFinding): SecurityFinding {
  return {
    ...f,
    title: maskSecrets(f.title),
    description: maskSecrets(f.description),
    evidence: f.evidence.map((e) => {
      const out: SecurityFinding["evidence"][number] = {
        source: maskSecrets(e.source),
        detail: maskSecrets(e.detail),
      };
      if (e.location !== undefined) out.location = maskSecrets(e.location);
      return out;
    }),
    remediation: maskSecrets(f.remediation),
    references: f.references.map(maskSecrets),
  };
}

export function buildReport(options: BuildReportOptions): SecurityReport {
  const parsed = reportOptionsSchema.safeParse(options);
  if (!parsed.success) throw new InputInvalidError(`report: ${issuePaths(parsed.error)}`);
  const { findings, toolVersion, generatedAt, scanScope } = parsed.data;
  return {
    schemaVersion: "1.0",
    toolVersion: maskSecrets(toolVersion),
    generatedAt,
    scanScope: [...new Set(scanScope.map(maskSecrets))].sort(compare),
    findings: findings.map(maskFinding),
    summary: summarize(findings),
  };
}
