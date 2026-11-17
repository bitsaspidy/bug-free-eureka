import { createHash } from "node:crypto";
import {
  maskSecrets,
  type SecurityFinding,
  type SecurityReport,
  type Severity,
} from "@bug-free-eureka/core";

const INFO_URI = "https://github.com/bitsaspidy/bug-free-eureka";
const MAX_MESSAGE = 1000;

type Level = "error" | "warning" | "note" | "none";
type Kind = "fail" | "review" | "pass";

const SECURITY_SEVERITY: Record<Severity, string> = {
  critical: "9.5",
  high: "8.0",
  medium: "5.0",
  low: "3.0",
  info: "0.0",
};

function failLevel(severity: Severity): Level {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

/** cli-sarif mapping. `not_assessed` is `review`/`none`: never `pass`. */
export function classify(f: SecurityFinding): { kind: Kind; level: Level } {
  switch (f.status) {
    case "fail":
      return { kind: "fail", level: failLevel(f.severity) };
    case "warning":
      return { kind: "review", level: "warning" };
    case "not_assessed":
      return { kind: "review", level: "none" };
    default:
      return { kind: "pass", level: "none" };
  }
}

function ruleName(title: string): string {
  return title
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

const SAFE_LOCATION = /^((?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+):(\d{1,9})(?::\d{1,9})?$/;

/** A relative POSIX `path:line` from rule evidence, or undefined. Never absolute or `..`. */
function evidenceLocation(f: SecurityFinding): { uri: string; line: number } | undefined {
  for (const e of f.evidence) {
    const m = e.location === undefined ? null : SAFE_LOCATION.exec(e.location);
    if (!m) continue;
    const uri = m[1] ?? "";
    const line = Number(m[2]);
    if (uri.split("/").some((s) => s === ".." || s === ".") || line < 1) continue;
    return { uri, line };
  }
  return undefined;
}

/** Percent-encodes each segment of a relative POSIX path so it is a valid URI reference. */
function encodeUri(path: string): string {
  // Lone surrogates make encodeURIComponent throw; replace them with U+FFFD first.
  const wellFormed = path.replace(/[\ud800-\udfff]/gu, "�");
  return wellFormed.split("/").map(encodeURIComponent).join("/");
}

function truncate(input: string): string {
  // Defence in depth: core already masks findings.
  const text = maskSecrets(input);
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 3)}...` : text;
}

function message(f: SecurityFinding): string {
  const details = f.evidence.map((e) => e.detail).join("; ");
  if (f.status === "not_assessed") {
    return truncate(`Not assessed (this is not a pass): ${f.title}. Missing evidence: ${details}`);
  }
  if (f.status === "warning") return truncate(`Warning: ${f.title}. ${f.remediation}`);
  return truncate(`${f.title}. ${f.remediation}`);
}

export interface SarifOptions {
  toolVersion: string;
  /** Fallback location per rule (its evidence file, else the config file), POSIX relative. */
  fallbackUri: (ruleId: string) => string;
}

/** SARIF 2.1.0 for GitHub code scanning (cli-sarif skill mapping). Pass results are omitted. */
export function renderSarif(report: SecurityReport, opts: SarifOptions): string {
  const seen = new Map<string, SecurityFinding>();
  for (const f of report.findings) if (!seen.has(f.ruleId)) seen.set(f.ruleId, f);
  const rules = [...seen.values()].map((f) => ({
    id: f.ruleId,
    name: ruleName(f.title),
    shortDescription: { text: maskSecrets(f.title) },
    fullDescription: { text: maskSecrets(f.description) },
    helpUri: `${INFO_URI}/blob/main/docs/rules/${f.ruleId}.md`,
    defaultConfiguration: { level: failLevel(f.severity) },
    properties: {
      "security-severity": SECURITY_SEVERITY[f.severity],
      tags: ["security"],
    },
  }));
  const results = report.findings
    .filter((f) => f.status !== "pass")
    .map((f) => {
      const { kind, level } = classify(f);
      const loc = evidenceLocation(f) ?? { uri: encodeUri(opts.fallbackUri(f.ruleId)), line: 1 };
      const fingerprint = createHash("sha256")
        .update(`${f.ruleId}\0${loc.uri}\0${f.status}`)
        .digest("hex");
      return {
        ruleId: f.ruleId,
        ruleIndex: rules.findIndex((r) => r.id === f.ruleId),
        kind,
        level,
        message: { text: message(f) },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: loc.uri, uriBaseId: "%SRCROOT%" },
              region: { startLine: loc.line },
            },
          },
        ],
        partialFingerprints: { "bfe/v1": fingerprint },
        properties: { status: f.status, confidence: f.confidence, severity: f.severity },
      };
    });
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Bug-Free Eureka",
            version: opts.toolVersion,
            semanticVersion: opts.toolVersion,
            informationUri: INFO_URI,
            rules,
          },
        },
        results,
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
