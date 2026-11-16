# Bug-Free Eureka — Master Specification v1.0 (condensed)

Updated 16 Nov 2026. Owner: bitsaspidy. This is the agents' working copy of the owner's blueprint; the owner's full version is authoritative if they differ.

**Goal:** a free, open-source, production-quality API security toolkit developers install inside existing Node.js apps — no separate server, database, hosting migration or subscription.
**Tagline:** Find risks. Fix configurations. Build with confidence.

## §1 Identity
Repo `bitsaspidy/bug-free-eureka` · Apache-2.0 · TypeScript · Node.js · Express first · GitHub + npm · GitHub Sponsors.
Topics: nodejs typescript express api-security cybersecurity owasp security-tools developer-tools open-source api-testing.

## §2 Non-goals
No full pentesting, no automatic discovery of every insecure route, no proof of absence of vulnerabilities, no guarantee against every OWASP risk.

## §3 Compatibility (targets, not verified)
Node 22/24/26 supported; 27 experimental; ≤20 unsupported. Review when Node 22 hits EOL (Apr 2027).
OS: Ubuntu (primary), Debian, RHEL family, Windows Server, macOS (dev), Fedora best effort. Hosts: EC2, Azure VM, GCE, DigitalOcean, dedicated, Docker, K8s, PM2, Apache/Nginx reverse proxy, load-balanced. Shared hosting & serverless: conditional (need adapter tests).
Reverse proxy topics to document+test: trust proxy & client IP, HTTPS termination / forwarded proto, secure cookies, multi-instance rate limits, external header/gateway interplay, untrusted forwarded headers.

## §4 Modules
A Auditor (core rules) · B Express adapter (opt-in middleware: limiter, log redaction, hardening) · C CLI (`init`, `audit`, `--format json|sarif`, `--output`, `--fail-on`) · D React dashboard (later, local-first, reads saved reports) · E Python validation scripts (optional, never required by Node users).

## §5 Stack
TS · Node · Express · Commander · Zod · Vitest · Supertest · tsup · VitePress · React+Vite (later) · Python+pytest (optional) · Redis-compatible adapter (optional) · GitHub Actions · CodeQL + dependency review · npm · Changesets.

## §6 Architecture rules
Core never imports Express · CLI uses core's stable API · adapters independently installable · deterministic rules · never execute scanned code · remote scanning off by default · distinguish fail vs not_assessed · no secrets in reports.

## §7 Layout
```
.github/{workflows/{ci,codeql,dependency-review,release,docs}.yml, ISSUE_TEMPLATE/, PULL_REQUEST_TEMPLATE.md, CODEOWNERS, FUNDING.yml}
packages/core/{src/{engine,rules,config,reporting,types}/,tests/}   → @bug-free-eureka/core
packages/express/{src/{middleware,adapters}/,tests/}                → @bug-free-eureka/express
packages/cli/{src/{commands,output}/,tests/}                        → @bug-free-eureka/cli
apps/{docs,dashboard}  examples/{basic-express,express-with-redis,vulnerable-fixtures}
scripts/python/  tests/{integration,fixtures,security}
docs/{architecture,rules,compatibility.md,threat-model.md,deployment.md,release-policy.md}
root: .changeset .editorconfig .npmrc .nvmrc package.json tsconfig.base.json eslint.config.js vitest.config.ts
      README LICENSE NOTICE CHANGELOG SECURITY CONTRIBUTING CODE_OF_CONDUCT GOVERNANCE SPONSORS
```
npm scope `@bug-free-eureka` must be confirmed/owned before publishing. NOTICE contains only real notices.

## §8 Rule registry
| ID | Concern | Default severity | Target |
|---|---|---|---|
| BFE-001 | Missing recommended security headers | medium | v0.1 |
| BFE-002 | Unsafe CORS on sensitive endpoints | high | v0.3 |
| BFE-003 | Missing request-size limit | medium | v0.1 |
| BFE-004 | Missing declared login rate-limit policy | high | v0.3 |
| BFE-005 | Sensitive data in configured logging | high | v0.1 |
| BFE-006 | Unsafe trusted-proxy configuration | high | v0.1 |
| BFE-007 | Stack traces in production error handling | medium | v0.3 |
| BFE-008 | Insecure session-cookie properties | high | v0.3 |
| BFE-009 | Missing auth policy for declared protected routes | high | later |
| BFE-010 | Insecure declared TLS deployment config | high | later |

## §9 Finding model (contract — changes need owner approval)
```ts
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "pass" | "fail" | "warning" | "not_assessed";
export interface Evidence { source: string; location?: string; detail: string }
export interface SecurityFinding {
  id: string; ruleId: string; ruleVersion: string;
  title: string; description: string;
  severity: Severity; confidence: "high" | "medium" | "low"; status: FindingStatus;
  evidence: Evidence[]; remediation: string; references: string[];
}
export interface SecurityReport {
  schemaVersion: "1.0"; toolVersion: string; generatedAt: string; scanScope: string[];
  findings: SecurityFinding[];
  summary: { passed: number; failed: number; warnings: number; notAssessed: number };
}
```

## §10 Express middleware requirements
Never log raw auth headers/passwords/OTPs/refresh tokens · established rate-limit algorithms · documented behavior when Redis is down · no unnecessary request/response changes · opt-in config with clear defaults · multi-instance via shared store · never silently disable an existing protection.

## §11 Root package.json
private, `workspaces: ["packages/*"]`, `engines.node ">=22 <27"`, scripts: build, test (`vitest run`), test:coverage, typecheck, lint, format:check, changeset.

## §12 CI
Matrix ubuntu/windows/macos × Node 22/24/26, fail-fast false: `npm ci` → lint → typecheck → test:coverage → build. Actions pinned to full SHAs. Separate least-privilege workflows: CodeQL (PR, main, weekly), dependency review (PR), Dependabot (weekly), security regression (PR, main), release verification (RC), docs deploy.

## §13 Testing policy
Unit · integration (Express) · negative · false-positive · unknown-state · compatibility · multi-instance · redaction · performance · supply-chain (package contents) · CLI (exit codes) · docs examples. Adversarial: malformed input, oversized requests, forged forwarded headers, nested secrets, missing proxy info, Redis outage, ambiguous config.
Release gate: matrix green · every rule has pass/fail/not_assessed fixtures · adversarial tests reviewed · no unaccepted blocking vulns · no secrets in reports/logs · clean external install · package contents verified · docs claims accurate · owner approves.

## §14 Releases
SemVer + Changesets. v0.1 core + first four rules (001, 003, 005, 006) · v0.2 Express adapter · v0.3 CI integration, JSON/SARIF · v0.4 expanded rules + beta · v1.0 stable after review · v1.1+ more frameworks, dashboard.
npm trusted publishing (OIDC; npm ≥11.5.1, Node ≥22.14 in the release job), provenance, owner approval, no publish from untrusted PRs, fix forward with a patch.

## §15 Sponsors & community
`.github/FUNDING.yml`: `github: [bitsaspidy]`. Proposed tiers $5 / $15 / $49 / $199 — no guaranteed fixes, certifications or SLAs. Community files: README, LICENSE, NOTICE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, GOVERNANCE, CHANGELOG, SPONSORS, docs/compatibility.md, docs/threat-model.md. Labels: bug, security, enhancement, documentation, good first issue, help wanted, breaking change. Board: Backlog → Ready → In Progress → Code Review → Testing → Done.

## §16 Roadmap (planning dates; security beats schedule)
16–22 Nov foundation · 23–29 Nov engine+schema · 30 Nov–13 Dec rules, CLI, reports · 14–27 Dec Express middleware · 28 Dec–10 Jan CI, docs, cross-platform · 11–17 Jan beta · 18–31 Jan feedback, API review · 1–7 Feb npm validation, sponsors · 8–13 Feb stable launch.
