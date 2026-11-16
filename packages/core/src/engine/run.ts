import type { Evidence, Rule, RuleResult, SecurityFinding } from "../types/index.js";
import { InputInvalidError } from "./errors.js";
import { maskSecrets } from "./mask.js";
import { createRegistry, RuleRegistry } from "./registry.js";
import { issuePaths, ruleResultSchema, runOptionsSchema } from "./schemas.js";
import { compare } from "./sort.js";

export interface RunOptions {
  /** Injected clock (Date or ISO-8601 UTC string). The engine never reads the system clock. */
  now: Date | string;
}

function compareEvidence(a: Evidence, b: Evidence): number {
  return (
    compare(a.source, b.source) ||
    compare(a.location ?? "", b.location ?? "") ||
    compare(a.detail, b.detail)
  );
}

function sanitizeEvidence(list: readonly Evidence[]): Evidence[] {
  return list
    .map((e): Evidence => {
      const out: Evidence = { source: maskSecrets(e.source), detail: maskSecrets(e.detail) };
      if (e.location !== undefined) out.location = maskSecrets(e.location);
      return out;
    })
    .sort(compareEvidence);
}

interface RuleMeta {
  id: string;
  version: string;
  title: string;
  description: string;
  defaultSeverity: SecurityFinding["severity"];
  references: readonly string[];
}

function toFinding(rule: RuleMeta, result: RuleResult): SecurityFinding {
  return {
    id: rule.id,
    ruleId: rule.id,
    ruleVersion: rule.version,
    title: rule.title,
    description: rule.description,
    severity: rule.defaultSeverity,
    confidence: result.confidence,
    status: result.status,
    evidence: sanitizeEvidence(result.evidence),
    remediation: maskSecrets(result.remediation),
    references: [...rule.references].sort(compare),
  };
}

function notAssessed(rule: RuleMeta, detail: string): SecurityFinding {
  return toFinding(rule, {
    status: "not_assessed",
    confidence: "low",
    evidence: [{ source: "engine", detail }],
    remediation:
      "This rule could not be assessed. Provide the missing evidence or report the rule problem to the maintainers.",
  });
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

// Rules are synchronous for now. A rule that returns a promise is a contract violation;
// we attach a no-op handler so a later rejection (which may carry secrets) is not unhandled.
function evaluateRule<TInput>(rule: Rule<TInput>, input: TInput, now: string): SecurityFinding {
  try {
    const raw: unknown = rule.evaluate({ input, now });
    if (isThenable(raw)) {
      Promise.resolve(raw).catch(() => undefined);
      return notAssessed(rule, "E_RULE_CRASH: rule returned a promise; rules must be synchronous.");
    }
    const parsed = ruleResultSchema.safeParse(raw);
    if (!parsed.success) {
      return notAssessed(
        rule,
        `E_RULE_CRASH: rule returned an invalid result (fields: ${issuePaths(parsed.error)}).`,
      );
    }
    return toFinding(rule, parsed.data);
  } catch {
    // Raw error text (or a hostile getter/Proxy) can carry secrets: report only the code.
    return notAssessed(rule, "E_RULE_CRASH: rule threw while evaluating; error details withheld.");
  }
}

/** Findings ordered by ruleId (one finding per rule; ids are unique). */
function sortFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.sort((a, b) => compare(a.ruleId, b.ruleId));
}

export function runRules<TInput>(
  rules: readonly Rule<TInput>[] | RuleRegistry<TInput>,
  input: TInput,
  options: RunOptions,
): SecurityFinding[] {
  const opts = runOptionsSchema.safeParse(options);
  if (!opts.success) throw new InputInvalidError(`options: ${issuePaths(opts.error)}`);
  const registry = rules instanceof RuleRegistry ? rules : createRegistry(rules);
  return sortFindings(registry.list().map((rule) => evaluateRule(rule, input, opts.data.now)));
}
