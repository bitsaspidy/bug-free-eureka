import {
  maskSecrets,
  type SecurityFinding,
  type SecurityReport,
  type Severity,
} from "@bug-free-eureka/core";

export interface Palette {
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  green(s: string): string;
  bold(s: string): string;
}

const plain = (s: string): string => s;
const ansi =
  (open: number, close: number) =>
  (s: string): string =>
    `\u001b[${open}m${s}\u001b[${close}m`;

export const PLAIN: Palette = {
  red: plain,
  yellow: plain,
  cyan: plain,
  green: plain,
  bold: plain,
};
export const COLOR: Palette = {
  red: ansi(31, 39),
  yellow: ansi(33, 39),
  cyan: ansi(36, 39),
  green: ansi(32, 39),
  bold: ansi(1, 22),
};

/** Colour only on a TTY and never when NO_COLOR is set; FORCE_COLOR (not "0"/"false") forces it on. */
export function useColor(
  isTTY: boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const force = env["FORCE_COLOR"];
  if (force !== undefined && force !== "" && force !== "0" && force !== "false") return true;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  return isTTY;
}

const ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

// Masks secrets (defence in depth) and neutralises terminal control characters.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
function clean(s: string): string {
  return maskSecrets(s).replace(CONTROL, "?");
}

function block(f: SecurityFinding, head: string, out: string[], missing: boolean): void {
  out.push(`${head} ${f.ruleId} ${clean(f.title)}`);
  for (const e of f.evidence) {
    const where = e.location ? ` (${clean(e.location)})` : "";
    out.push(`  ${missing ? "missing" : "evidence"}: ${clean(e.detail)}${where}`);
  }
  out.push(`  fix: ${clean(f.remediation)}`, "");
}

export function renderText(report: SecurityReport, c: Palette): string {
  const s = report.summary;
  const out: string[] = [
    c.bold(`Bug-Free Eureka ${report.toolVersion} audit`),
    `Summary: ${c.red(`${s.failed} failed`)}, ${c.yellow(`${s.warnings} warnings`)}, ` +
      `${c.cyan(`${s.notAssessed} not assessed`)}, ${c.green(`${s.passed} passed`)}`,
    "",
  ];
  const failed = report.findings
    .filter((f) => f.status === "fail")
    .sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  for (const f of failed) block(f, c.red(`FAIL [${f.severity}]`), out, false);
  for (const f of report.findings.filter((x) => x.status === "warning")) {
    block(f, c.yellow(`WARNING [${f.severity}]`), out, false);
  }
  for (const f of report.findings.filter((x) => x.status === "not_assessed")) {
    block(f, c.cyan("NOT ASSESSED (not a pass)"), out, true);
  }
  for (const f of report.findings.filter((x) => x.status === "pass")) {
    out.push(`${c.green("PASS")} ${f.ruleId} ${clean(f.title)}`);
  }
  if (report.findings.length === 0) out.push("No rules were run.");
  out.push(
    "",
    "Severities are defaults, not risk judgments. A pass does not mean the application is secure.",
  );
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}
