# Work orders — status board

Status: `todo` · `in-progress` · `review` (PR open) · `done` (merged by owner). The lead updates this file in the same PR as the work.

| WO | Title | Owner role(s) | Acceptance | Status | PR |
|---|---|---|---|---|---|
| WO-000 | AI agent system | eureka-lead | Agents, skills, hooks, docs load in Claude Code | done | [#1](https://github.com/bitsaspidy/bug-free-eureka/pull/1) |
| WO-001 | Repository foundation (workspaces, TS, tsup, ESLint, Prettier, Vitest, Changesets, community files) | devops-release, docs-community | Clean checkout: `npm ci && npm run build && npm run typecheck && npm test` pass | done | [PR #3](https://github.com/bitsaspidy/bug-free-eureka/pull/3) |
| WO-002 | Security rule engine (types, registry, evidence, not_assessed, report builder) | core-engineer, qa-engineer | Deterministic; pass/fail/not_assessed tests | done | [PR #7](https://github.com/bitsaspidy/bug-free-eureka/pull/7) |
| WO-003 | BFE-001 security headers | rule-analyst → core-engineer | No assumption about unknown proxy behavior | done | [PR #9](https://github.com/bitsaspidy/bug-free-eureka/pull/9) |
| WO-004 | BFE-003 request limits + BFE-006 trusted proxy | rule-analyst → core-engineer | Valid/invalid/unknown cases tested | done | [PR #10](https://github.com/bitsaspidy/bug-free-eureka/pull/10) |
| WO-005 | BFE-005 sensitive logging + redaction utility | core-engineer, security-reviewer | Known secrets never leak (redaction-check skill) | done | [PR #18](https://github.com/bitsaspidy/bug-free-eureka/pull/18) |
| WO-006 | CLI: init, audit, JSON output, exit codes | integrations-engineer | Works in a clean external example | done | [PR #22](https://github.com/bitsaspidy/bug-free-eureka/pull/22) |
| WO-007 | Express adapter: limiter, audit logger, Redis option | integrations-engineer, security-reviewer | HTTP + multi-instance tests, documented failure modes | review | [PR #25](https://github.com/bitsaspidy/bug-free-eureka/pull/25) |
| WO-008 | Cross-platform CI, CodeQL, dependency review, Dependabot | devops-release | Matrix green; checks required on `main` | done | [PR #13](https://github.com/bitsaspidy/bug-free-eureka/pull/13) |
| WO-009 | Docs (VitePress, quickstart, config ref, limitations, deployment) | docs-community | Independent dev can run examples | todo | — |
| WO-010 | Publishing (Changesets, package validation, OIDC, provenance) | devops-release | Prerelease installs cleanly | todo | — |
| WO-011 | Sponsors & governance | docs-community | Policies & funding understandable | todo | — |
| WO-012 | External beta | eureka-lead | Blockers resolved | todo | — |
| WO-013 | Stable v1.0.0 | all | All release gates pass | todo | — |
| WO-014 | Post-launch improvement | eureka-lead | Roadmap reflects adoption | todo | — |
