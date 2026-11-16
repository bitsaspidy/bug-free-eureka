---
name: cli-sarif
description: Build the Bug-Free Eureka CLI correctly — Commander command structure, safe JSON-only config, stdout/stderr discipline, exit codes, colors/TTY, atomic report writing, init without clobbering, and JSON + SARIF 2.1.0 output that GitHub code scanning accepts. Use when working in packages/cli or on report formats.
---

# CLI + report formats

npm latest on 2026-11-16: commander 15.1.

## Structure
```
packages/cli/src/index.ts        #!/usr/bin/env node → main(process.argv).then(c => { process.exitCode = c })
packages/cli/src/run.ts          export async function run(argv, io): Promise<ExitCode>  (testable, no process.*)
packages/cli/src/commands/{init,audit}.ts
packages/cli/src/output/{text,json,sarif}.ts
```
* Commander: `program.name("bug-free-eureka").version(pkgVersion)`, `.exitOverride()` (Commander errors become exit code 2), `.configureOutput({ writeOut, writeErr })` into `io`, and `await program.parseAsync(argv)`.
* `package.json` `bin: { "bug-free-eureka": "./dist/index.js" }`. npm creates `.cmd` shims on Windows, so no extra work is needed. Keep the shebang in the built file (tsup `banner`).
* Set `process.exitCode`, never `process.exit()` in normal paths, so stdout flushes when piped.

## Exit codes (documented and tested)
| Code | Meaning |
|---|---|
| 0 | Success; no finding at or above `--fail-on` |
| 1 | Findings at or above `--fail-on` (only `status: fail`; `not_assessed` never fails CI unless `--fail-on-unassessed`) |
| 2 | Usage or config error (bad flag, invalid config, path outside the project) |
| 3 | Internal error (bug), with a hint to rerun with `--debug` and report it |

## Config
* JSON only: `bug-free-eureka.config.json`, or `--config <path>`. **Never load `.js`/`.ts` config.** That would execute project code (CLAUDE.md §1.5).
* Validate with Zod `strictObject`. Errors print `config.rules.BFE-003.limit: expected string like "100kb"` (path + expectation, no values).
* `init` writes a commented default config (`$schema` URL, all rules listed). It refuses to overwrite without `--force`, and prints the next command to run.

## Output discipline
* stdout carries **only** the report. Progress, warnings and errors go to stderr. `--format json` stdout must be valid JSON and nothing else.
* Colors only when `stdout.isTTY` and `NO_COLOR` is unset (`FORCE_COLOR` overrides). No emoji in json/sarif.
* `--output <file>`: write to a temp file in the same directory, then `rename` (atomic). Create parent directories. Print the written path to stderr.
* `--debug` adds stacks and timings to stderr. Even then, never print config values or secrets.
* Text report: a summary line (passed / failed / warnings / not assessed), then failed findings by severity with remediation, then not_assessed items with "what evidence is missing".

## SARIF 2.1.0 mapping
```jsonc
{ "$schema": "https://json.schemastore.org/sarif-2.1.0.json", "version": "2.1.0",
  "runs": [{ "tool": { "driver": { "name": "Bug-Free Eureka", "version": "<toolVersion>",
      "informationUri": "https://github.com/bitsaspidy/bug-free-eureka",
      "rules": [{ "id": "BFE-001", "name": "MissingSecurityHeaders", "shortDescription": { "text": "…" },
                  "helpUri": "<docs url>", "defaultConfiguration": { "level": "warning" },
                  "properties": { "security-severity": "5.0", "tags": ["security"] } }] } },
    "results": [{ "ruleId": "BFE-001", "kind": "fail", "level": "warning",
      "message": { "text": "…" },
      "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "src/app.ts", "uriBaseId": "%SRCROOT%" },
                                            "region": { "startLine": 12 } } }],
      "partialFingerprints": { "bfe/v1": "<sha256(ruleId+uri+evidenceKey)>" } }] }] }
```
| Finding status | SARIF `kind` / `level` |
|---|---|
| fail, critical/high | `fail` / `error` |
| fail, medium | `fail` / `warning` |
| fail, low/info | `fail` / `note` |
| warning | `review` / `warning` |
| not_assessed | `review` / `none` (omit with `--sarif-failures-only`) |
| pass | `pass` / `none` (omitted by default) |

* `security-severity` (as a string): critical 9.5, high 8.0, medium 5.0, low 3.0. GitHub uses it to rank alerts.
* URIs are relative POSIX paths. Configuration-only findings without a file use the config file as the location.
* Fingerprints must be stable across runs and machines (no absolute paths, no times).
* GitHub upload (documented for users): `github/codeql-action/upload-sarif` with `security-events: write`.

## JSON report
This is exactly the `SecurityReport` schema (BLUEPRINT §9) with `schemaVersion: "1.0"`, validated against `z.toJSONSchema` output in tests. A breaking schema change means a new `schemaVersion`.
