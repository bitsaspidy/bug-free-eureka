<p align="center">
  <img src="docs/assets/banner.png" width="100%" alt="Bug-Free Eureka: open-source API security toolkit for Node.js and Express. Find risks. Fix configurations. Build with confidence.">
</p>

[![CI](https://github.com/bitsaspidy/bug-free-eureka/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bitsaspidy/bug-free-eureka/actions/workflows/ci.yml)

# Bug-Free Eureka

**Find risks. Fix configurations. Build with confidence.**

Bug-Free Eureka is an open-source API security toolkit for Node.js and Express. It detects common security misconfigurations, audits API configuration and helps keep sensitive data out of your logs, and it runs inside your existing app.

> **Status: early development.** Nothing is published to npm yet, and the APIs below may change. See [Roadmap](#roadmap) and the [work-order board](docs/WORK_ORDERS.md).

Read the announcement: [Introducing Bug-Free Eureka](https://satsaiinfo.com/blog/introducing-bug-free-eureka-an-open-source-api-security-toolkit-for-nodejs-and-express)

## Why Bug-Free Eureka

- **Runs inside your app.** No separate server, no port change, no route rewrites and no silent production changes.
- **No mandatory infrastructure.** No database, Redis, Docker, cloud account or API key is required.
- **Unknown is not a pass.** If a rule can't establish the facts (for example, how your reverse proxy is configured), it reports `not_assessed` instead of assuming you're fine.
- **Deterministic.** The same input always gives the same findings: no network, clock or randomness inside rule logic.
- **Never executes scanned code.** The static audit only reads and parses files, with size and path-traversal limits.
- **No secrets in output.** Reports, logs and errors never contain tokens, passwords, cookies or auth headers.

## Packages

| Package | What it does | Status |
|---|---|---|
| [`@bug-free-eureka/core`](packages/core) | Rule engine, rules, finding model and report builder. Framework-free. | In progress |
| [`@bug-free-eureka/cli`](packages/cli) | `init` and `audit` commands, JSON and SARIF output, `--fail-on` for CI. | Planned |
| [`@bug-free-eureka/express`](packages/express) | Opt-in middleware: rate limiter (in-memory or Redis-compatible), redacting audit logger, hardening. | Planned |

## Rules

| ID | Checks for | Default severity | Status |
|---|---|---|---|
| [BFE-001](docs/rules/BFE-001.md) | Missing recommended security headers | medium | Implemented |
| [BFE-003](docs/rules/BFE-003.md) | Missing request-size limit | medium | Implemented |
| [BFE-006](docs/rules/BFE-006.md) | Unsafe trusted-proxy configuration | high | Implemented |
| BFE-005 | Sensitive data in configured logging | high | Planned (v0.1) |
| BFE-002 | Unsafe CORS on sensitive endpoints | high | Planned (v0.3) |
| BFE-004 | Missing declared login rate-limit policy | high | Planned (v0.3) |
| BFE-007 | Stack traces in production error handling | medium | Planned (v0.3) |
| BFE-008 | Insecure session-cookie properties | high | Planned (v0.3) |

Every finding is `pass`, `fail` or `not_assessed`, with evidence and a suggested fix. Severities are defaults, not a judgment of your actual risk.

## Compatibility

Tested in CI on Node.js **22, 24 and 26** on Linux, Windows and macOS (`engines: ">=22 <27"`), with ESM and CommonJS builds. Every pull request runs lint, typecheck, tests with coverage and build across that full matrix.

## Develop locally

Requires Node.js 22 or newer and npm 11.

```bash
git clone https://github.com/bitsaspidy/bug-free-eureka.git
cd bug-free-eureka
npm ci
npm run build
npm test
```

TypeScript is pinned to `~6.0.0` because typescript-eslint 8.72.2 supports only `typescript <6.1`; Dependabot ignores newer TypeScript until that changes.

Other scripts: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:coverage`.

## Roadmap

Planning dates; security beats schedule.

- **v0.1:** core engine and the first four rules (BFE-001, 003, 005, 006)
- **v0.2:** Express adapter
- **v0.3:** CLI and CI integration with JSON and SARIF reports
- **v0.4:** more rules and a public beta (January 2027)
- **v1.0:** stable release after review (February 2027)

## What it is not

Bug-Free Eureka finds common, well-defined misconfigurations. It is not a penetration test, it can't prove that vulnerabilities are absent, and it doesn't make an app "secure" or "OWASP compliant" on its own.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md), then use the issue templates to report a bug or propose a rule.

## Security

Please don't open public issues for vulnerabilities. [Report them privately](https://github.com/bitsaspidy/bug-free-eureka/security/advisories/new); see [SECURITY.md](SECURITY.md).

## License

Licensed under [Apache-2.0](LICENSE). Maintained by Devavrat Singh ([@bitsaspidy](https://github.com/bitsaspidy)).
