# CLI reference

`@bug-free-eureka/cli` audits a project from JSON evidence files. It is not on npm yet: build it as in the [quickstart](/quickstart) and run `node <repo>/packages/cli/dist/bin.js`. The examples below write that as `bug-free-eureka`.

## Commands

```bash
bug-free-eureka init                    # writes bug-free-eureka.config.json; exit 2 if it exists (use --force)
bug-free-eureka audit                   # text report on stdout
bug-free-eureka audit --format json     # SecurityReport JSON (schemaVersion "1.0")
bug-free-eureka audit --format sarif --output results.sarif
bug-free-eureka --help                  # also: init --help, audit --help, --version
```

`audit` options:

| Option | Default | Meaning |
|---|---|---|
| `--config <path>` | `bug-free-eureka.config.json` | Config file, inside the project directory. See [configuration](/configuration). |
| `--format text\|json\|sarif` | `text` | Report format. |
| `--output <file>` | stdout | Write the report to a file inside the project directory. |
| `--fail-on critical\|high\|medium\|low\|info\|none` | `high` | Exit `1` when a **failed** finding has this severity or higher. `none` never fails on findings. |
| `--fail-on-unassessed` | off | Also exit `1` when any enabled rule is not assessed. |
| `--debug` | off | Timings and internal error stacks on stderr (never config or secret values). |

`init` takes `--config <path>` (where to write) and `--force` (overwrite). Warnings never change the exit code. Disabled rules are left out of the report.

<!--@include: ../packages/cli/README.md{16,}-->

## SARIF in GitHub Actions

Until the CLI is on npm, a workflow checks out and builds this repository next to your code. The audit runs with `--fail-on none` so the SARIF is always uploaded; a second step applies the threshold.

```yaml
name: API security audit
on: [pull_request, push]
permissions:
  contents: read
jobs:
  audit:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write # upload-sarif only
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: bitsaspidy/bug-free-eureka
          ref: main # pin a commit SHA for reproducible results
          path: .bfe
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: npm ci && npm run build
        working-directory: .bfe
      - run: node .bfe/packages/cli/dist/bin.js audit --format sarif --output results.sarif --fail-on none
      - uses: github/codeql-action/upload-sarif@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3
        with:
          sarif_file: results.sarif
      - run: node .bfe/packages/cli/dist/bin.js audit --fail-on high
```

The SHAs are the ones this repository uses; check for newer releases before you copy them. Code scanning shows failed findings as alerts. Not assessed findings appear with level `none` (`kind: "review"`), so they are visible but never look like a pass. Passes are omitted.
