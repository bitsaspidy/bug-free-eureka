import {
  buildReport,
  builtinRules,
  runRules,
  type SecurityFinding,
  type SecurityReport,
  type Severity,
} from "@bug-free-eureka/core";
import { CONFIG_FILE, describePath, loadConfig, type RuleId } from "../config.js";
import { EXIT, type ExitCode } from "../errors.js";
import { parseJson, readSmallFile, resolveInside, writeAtomic } from "../fs-safe.js";
import type { CliIo } from "../io.js";
import { renderJson } from "../output/json.js";
import { renderSarif } from "../output/sarif.js";
import { COLOR, PLAIN, renderText, useColor } from "../output/text.js";
import { version } from "../version.js";

export const FORMATS = ["text", "json", "sarif"] as const;
export type Format = (typeof FORMATS)[number];
export const FAIL_ON = ["critical", "high", "medium", "low", "info", "none"] as const;
export type FailOn = (typeof FAIL_ON)[number];

export interface AuditOptions {
  config?: string;
  format: Format;
  output?: string;
  failOn: FailOn;
  failOnUnassessed: boolean;
  debug: boolean;
}

const RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Exit 1 only for `status: fail` at or above the threshold; `not_assessed` only when asked. */
export function shouldFail(
  findings: readonly SecurityFinding[],
  failOn: FailOn,
  failOnUnassessed: boolean,
): boolean {
  return findings.some(
    (f) =>
      (f.status === "fail" && failOn !== "none" && RANK[f.severity] >= RANK[failOn]) ||
      (failOnUnassessed && f.status === "not_assessed"),
  );
}

export async function audit(root: string, opts: AuditOptions, io: CliIo): Promise<ExitCode> {
  const now = (io.now ?? (() => new Date()))();
  const { config, path: configPath } = await loadConfig(root, opts.config);
  if (configPath === undefined) {
    io.stderr.write(
      `No ${CONFIG_FILE} found: every rule will be reported as not assessed. Run: npx bug-free-eureka init\n`,
    );
  }
  const configUri = configPath === undefined ? CONFIG_FILE : describePath(root, configPath);
  const scope = new Set<string>(configPath === undefined ? [] : [configUri]);
  const evidenceUri = new Map<string, string>();
  const findings: SecurityFinding[] = [];

  for (const rule of builtinRules) {
    const ruleCfg = config.rules[rule.id as RuleId];
    if (ruleCfg?.enabled === false) continue;
    let input: unknown;
    if (ruleCfg?.evidence !== undefined) {
      const label = `config.rules.${rule.id}.evidence`;
      const abs = await resolveInside(root, ruleCfg.evidence, label);
      input = parseJson(await readSmallFile(abs, label), label);
      const rel = describePath(root, abs);
      scope.add(rel);
      evidenceUri.set(rule.id, rel);
    }
    const started = performance.now();
    findings.push(...runRules([rule], input, { now }));
    if (opts.debug) {
      io.stderr.write(
        `debug: ${rule.id} evaluated in ${(performance.now() - started).toFixed(1)} ms\n`,
      );
    }
  }

  const report: SecurityReport = buildReport({
    findings,
    toolVersion: version,
    generatedAt: now,
    scanScope: [...scope].sort(),
  });

  let body: string;
  if (opts.format === "json") body = renderJson(report);
  else if (opts.format === "sarif") {
    body = renderSarif(report, {
      toolVersion: version,
      fallbackUri: (id) => evidenceUri.get(id) ?? configUri,
    });
  } else {
    const color = opts.output === undefined && useColor(io.isTTY, io.env);
    body = renderText(report, color ? COLOR : PLAIN);
  }

  if (opts.output === undefined) {
    io.stdout.write(body);
  } else {
    const abs = await resolveInside(root, opts.output, "--output");
    await writeAtomic(root, abs, body, "--output");
    io.stderr.write(`Wrote ${describePath(root, abs)}\n`);
  }

  return shouldFail(report.findings, opts.failOn, opts.failOnUnassessed) ? EXIT.FINDINGS : EXIT.OK;
}
