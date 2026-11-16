// BLUEPRINT §9 finding model. This is a contract: do not change its shape
// without the owner's approval.
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "pass" | "fail" | "warning" | "not_assessed";
export type Confidence = "high" | "medium" | "low";

export interface Evidence {
  source: string;
  location?: string;
  detail: string;
}

export interface SecurityFinding {
  id: string;
  ruleId: string;
  ruleVersion: string;
  title: string;
  description: string;
  severity: Severity;
  confidence: Confidence;
  status: FindingStatus;
  evidence: Evidence[];
  remediation: string;
  references: string[];
}

export interface SecurityReport {
  schemaVersion: "1.0";
  toolVersion: string;
  generatedAt: string;
  scanScope: string[];
  findings: SecurityFinding[];
  summary: { passed: number; failed: number; warnings: number; notAssessed: number };
}
