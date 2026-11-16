---
name: release-gate
description: Pre-release go/no-go for a Bug-Free Eureka version (v0.x / v1.0) — runs the blueprint's 9-point release checklist with evidence, clean external install, package contents, changelog and docs-claims review. Use before asking the owner to approve any npm publish.
---

# Release gate

Lead coordinates; qa-engineer and security-reviewer supply evidence; owner decides.

| # | Gate | Evidence required | Who |
|---|---|---|---|
| 1 | OS × Node matrix green | link to CI run on the release commit | devops-release |
| 2 | Every enabled rule has pass/fail/not_assessed fixtures | list per rule | qa-engineer |
| 3 | Adversarial tests reviewed | security-reviewer report | security-reviewer |
| 4 | No unaccepted blocking vulnerabilities | `npm audit --omit=dev`, CodeQL, Dependabot status | security-reviewer |
| 5 | No secrets in reports/logs | `redaction-check` result | qa-engineer |
| 6 | Clean external install | temp project: `npm init -y && npm i <tarballs>`; ESM + CJS import; CLI `--version`, `audit` on `examples/basic-express` | qa-engineer |
| 7 | Package contents verified | `npm pack --dry-run` per package | devops-release |
| 8 | Docs & platform claims accurate | README/docs vs. CI evidence; nothing "supported" that isn't tested | docs-community + lead |
| 9 | Owner approval | owner approves the `npm-release` environment run | **owner only** |

Also: changesets present and CHANGELOG readable; version numbers consistent across packages; Git tag matches.

Output a table with ✅ / ❌ / ⚠️ per gate and the evidence link. Any ❌ = NO-GO. Use the built-in `engineering:deploy-checklist` skill for anything not covered here.
