import type { SecurityReport } from "@bug-free-eureka/core";

/** The JSON report is exactly core's SecurityReport (BLUEPRINT §9), schemaVersion "1.0". */
export function renderJson(report: SecurityReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
