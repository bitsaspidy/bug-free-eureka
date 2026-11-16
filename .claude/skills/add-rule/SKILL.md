---
name: add-rule
description: Implement a new Bug-Free Eureka security rule BFE-xxx in packages/core with its fixtures, tests, registry entry and docs page. Use when implementing or substantially changing any rule.
---

# Add a rule

Prerequisite: `docs/rules/BFE-xxx.md` exists (rule-analyst spec). If not, stop and ask the lead.

## Files (one rule = these, nothing else)
```
packages/core/src/rules/bfe-xxx-<slug>.ts        rule implementation
packages/core/src/rules/index.ts                 add to registry (sorted by id)
packages/core/tests/rules/bfe-xxx.test.ts        tests
tests/fixtures/rules/bfe-xxx/{pass,fail,not-assessed,adversarial}*.json
docs/rules/BFE-xxx.md                            update "Implementation" line
```

## Implementation shape
```ts
export const bfeXxx: RuleDefinition<Input> = {
  id: "BFE-xxx", version: "1.0.0", title: "…",
  defaultSeverity: "medium",
  inputSchema,                       // Zod
  evaluate(input, ctx): SecurityFinding[] { … }   // pure, deterministic
};
```
* Validate input with the schema first; invalid input → `not_assessed` finding with evidence "input invalid: <path>" (no values).
* Evidence `detail` describes *what* was found, never the secret value; mask with core's `mask()`.
* `references` = URLs from the spec only.
* Bump `version` on any behavior change; patch for wording, minor for new detection, major for changed status outcomes.

## Tests (minimum)
1. each fail fixture → `status: "fail"` with expected severity/confidence
2. each pass fixture → `status: "pass"` (false-positive guard)
3. not-assessed fixtures → `status: "not_assessed"`
4. adversarial (malformed, huge, nested secrets) → no throw, no secret in `JSON.stringify(findings)`
5. determinism: evaluate twice → deep-equal
Run: `npx vitest run packages/core/tests/rules/bfe-xxx.test.ts --coverage.enabled=false --reporter=dot`.
