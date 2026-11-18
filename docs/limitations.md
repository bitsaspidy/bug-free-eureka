# Limitations

Bug-Free Eureka is in early development. Read this before you rely on a result.

## What it is not

- **Not a security guarantee.** A pass means the evidence you supplied matched the rule. It does not mean the application is secure, compliant or free of bugs.
- **Not a scanner of your source code (yet).** The CLI does not parse your code. It reads JSON evidence files that you write. If the evidence is wrong, so is the result.
- **Not a penetration test or a runtime monitor.** It sends no requests to your app and never runs your code.
- **Not a replacement for your proxy, WAF or gateway.** It does not know what Nginx, a CDN or a load balancer does unless you declare it.
- **Not on npm.** The packages are built from the repository. APIs may change before 1.0.
- **Four rules only:** BFE-001, BFE-003, BFE-005 and BFE-006. Hardening middleware (security headers and similar) is not built.

## `not_assessed` is not a pass

A rule reports `not_assessed` when it cannot establish the facts: no evidence file, invalid evidence, or evidence that says a fact is `unknown` (for example a proxy whose configuration you did not supply). The rule never guesses.

- By default, not assessed findings do not change the exit code. Use `--fail-on-unassessed` in CI to make them fail the build.
- In SARIF they have level `none` and `kind: "review"`, so they are visible in code scanning without looking like a pass.
- In the text report they are labelled `NOT ASSESSED (not a pass)`.

## Other limits

- **Severities are defaults.** `high` on BFE-006 is the registry default, not a judgment of your risk.
- **Redaction works by name.** The audit logger masks values under sensitive names (`authorization`, `cookie`, `password` and similar) and secret-looking strings. A secret under an innocent name must be added to `sensitiveKeys`.
- **The in-memory rate-limit store is per process.** With several processes or hosts, each has its own counts. Use a shared store (see the [deployment guide](/deployment#more-than-one-instance)).
- **Platforms:** CI tests Node.js 22, 24 and 26 on Linux, Windows and macOS. Docker, PM2, Nginx, Kubernetes and serverless setups are documented but not tested in CI.

Each rule page lists its own known limits in its last section.
