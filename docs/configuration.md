# Configuration reference

The CLI reads one JSON config file, `bug-free-eureka.config.json` by default (`--config <path>` to change it). `bug-free-eureka init` writes one with every rule enabled.

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

| Key | Required | Meaning |
|---|---|---|
| `$schema` | no | JSON Schema for editor completion and validation. The file is [`packages/cli/schema/config.schema.json`](https://github.com/bitsaspidy/bug-free-eureka/blob/main/packages/cli/schema/config.schema.json). |
| `version` | yes | Must be `1`. |
| `rules` | no | One entry per rule ID: `BFE-001`, `BFE-003`, `BFE-005`, `BFE-006`. Unknown rule IDs and unknown keys are an error (exit `2`). |
| `rules.<id>.enabled` | no | `true` (default) runs the rule; `false` leaves it out of the report. |
| `rules.<id>.evidence` | no | Path to the rule's evidence file, relative to the project root, ending in `.json`, at most 1000 characters. Without it, the rule is **not assessed**. |

## Evidence files

An evidence file is the rule's input as JSON: a description of your app and deployment that you (or, later, a collector) write. Its exact shape is in section 2.1 of each rule page, and the CLI rejects input that does not match it. When an evidence file is invalid, that rule is reported as not assessed with `input invalid` and the paths of the bad fields, never their values. A file that is not valid JSON is an error (exit `2`).

| Rule | Input type | Describe |
|---|---|---|
| [BFE-001](/rules/BFE-001) | `SecurityHeadersInput` | App kind, HTTPS, proxy, helmet mounts and observed headers |
| [BFE-003](/rules/BFE-003) | `RequestSizeInput` | Body parsers, upload limits, proxy and server caps |
| [BFE-005](/rules/BFE-005) | `SensitiveLoggingInput` | Loggers and what they log, with redaction settings |
| [BFE-006](/rules/BFE-006) | `TrustedProxyInput` | Deployment topology and the `trust proxy` setting |

## Limits

- Config and evidence files must be JSON, at most 8 MiB each.
- They must be inside the project directory (the working directory). Paths that leave it, and symlinks that lead outside it, are refused with exit `2`. The same applies to `--output`.
- The CLI never runs, imports or requires your code, and it makes no network requests.
