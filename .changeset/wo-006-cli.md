---
"@bug-free-eureka/cli": minor
---

Add the `bug-free-eureka` CLI: `init` writes a safe JSON config (never overwrites without `--force`), and `audit` runs the built-in rules (BFE-001, 003, 005, 006) on JSON evidence files, with text, JSON and SARIF 2.1.0 output, atomic `--output`, `--fail-on` and documented exit codes (0, 1, 2, 3).
