# @bug-free-eureka/cli

Command-line interface for Bug-Free Eureka. **Not yet on npm**: build it from this repository.

## Commands

```bash
npx bug-free-eureka init                     # writes bug-free-eureka.config.json (never overwrites without --force)
npx bug-free-eureka audit                    # text report on stdout
npx bug-free-eureka audit --format json      # SecurityReport JSON (schemaVersion "1.0")
npx bug-free-eureka audit --format sarif --output results.sarif
```

`audit` options: `--config <path>`, `--format text|json|sarif` (default `text`), `--output <file>`, `--fail-on critical|high|medium|low|info|none` (default `high`), `--fail-on-unassessed`, `--debug`.

## How it audits

The CLI never runs, imports or requires your code. Each rule reads a JSON **evidence file** that describes your app (its input schema is in `docs/rules/BFE-XXX.md`, section 2.1). List them in the config:

```json
{
  "$schema": "https://raw.githubusercontent.com/bitsaspidy/bug-free-eureka/main/packages/cli/schema/config.schema.json",
  "version": 1,
  "rules": {
    "BFE-001": { "evidence": "security/bfe-001.json" },
    "BFE-003": { "enabled": true },
    "BFE-005": { "enabled": false },
    "BFE-006": { "evidence": "security/bfe-006.json" }
  }
}
```

A rule without evidence is reported as **not assessed**, which is never a pass. Config and evidence files must be JSON, at most 8 MiB, and inside the project directory (the working directory); so must `--output`. Symlinks that lead outside it are refused.

## Output

* stdout carries only the report; progress and errors go to stderr.
* Colour is used only for the text report on a terminal, and never when `NO_COLOR` is set (`FORCE_COLOR` turns it on).
* `--output` writes to a temp file in the same directory and then renames it, so a reader never sees a partial report.
* SARIF 2.1.0 output is built for GitHub code scanning (upload with `github/codeql-action/upload-sarif`, which needs `security-events: write`). Failed findings map to `error`, `warning` or `note` by severity; not assessed findings are `kind: "review"`, `level: "none"`; passes are omitted.
* Reports, errors and `--debug` output never include secret values or config values.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No failed finding at or above `--fail-on` |
| 1 | At least one failed finding at or above `--fail-on` (or a not assessed rule, with `--fail-on-unassessed`) |
| 2 | Usage, config or path error: bad flag, invalid config or evidence, path outside the project, existing config without `--force` |
| 3 | Internal error (a bug): rerun with `--debug` and report it |

Severities are defaults, not risk judgments. A pass does not mean the application is secure.
