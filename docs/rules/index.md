# Rules

Each rule reads one evidence file and returns `pass`, `warning`, `fail` or `not_assessed`, with evidence and a suggested fix. Severities are defaults, not a judgment of your actual risk.

| ID | Checks for | Default severity |
|---|---|---|
| [BFE-001](./BFE-001) | Missing recommended security headers | medium |
| [BFE-003](./BFE-003) | Missing request-size limit | medium |
| [BFE-005](./BFE-005) | Sensitive data in configured logging | high |
| [BFE-006](./BFE-006) | Unsafe trusted-proxy configuration | high |

BFE-002, BFE-004, BFE-007 and BFE-008 are planned and not built yet.

Each rule page is the full specification: its input type (section 2.1), decision table, fixtures and known limits.
