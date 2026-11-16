import type { Confidence, Evidence, FindingStatus, Severity } from "./finding.js";

/** Context handed to a rule. The clock is injected; rules never read time themselves. */
export interface RuleContext<TInput = unknown> {
  readonly input: TInput;
  /** ISO-8601 UTC timestamp supplied by the caller. */
  readonly now: string;
}

/** What a rule decides. The engine turns it into a SecurityFinding. */
export interface RuleResult {
  status: FindingStatus;
  confidence: Confidence;
  evidence: Evidence[];
  remediation: string;
}

/** A pure, deterministic rule: no I/O, network, clock or randomness. */
export interface Rule<TInput = unknown> {
  /** `BFE-\d{3}` */
  readonly id: string;
  /** SemVer. Bump on any behavior change. */
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly defaultSeverity: Severity;
  readonly references: readonly string[];
  evaluate(ctx: RuleContext<TInput>): RuleResult;
}
