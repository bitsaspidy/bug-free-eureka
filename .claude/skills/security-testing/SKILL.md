---
name: security-testing
description: Attack playbook for testing Bug-Free Eureka's own security — redaction bypass, forwarded-header spoofing, rate-limiter bypass, DoS/resource exhaustion, scanner path traversal and symlinks, prototype pollution, terminal/ANSI and SARIF output injection, CLI argument abuse, and supply-chain checks (npm audit, signatures, install scripts, package contents). Use when writing security tests, before releases, or after any security-sensitive change.
---

# Security testing playbook

Targets are local only: our packages, `examples/`, fixtures. Every attack becomes a Vitest test named `SEC-<AREA>-<n>: <what>` under `tests/security/` (cross-package) or `packages/<pkg>/tests/security/`.

## 1. Redaction bypass (AREA = RED)
Start from the `redaction-check` canaries, then try to slip past the redactor:
* key variants: `Authorization`, `AUTHORIZATION`, `authorization ` (trailing space), `x-api-key`, `X_Api_Key`, unicode look-alikes (`pаssword` with a Cyrillic а). Decide on purpose: either documented as not covered or covered.
* positions: arrays of objects, `Map`/`Set`, class instances, getters, `toJSON()` methods that return secrets, `Error.cause` chains, `Buffer` values, objects with null prototype, circular structures, 10k-deep nesting.
* values: a secret inside a URL query (`?token=`), in `Basic base64(user:pass)`, in a JSON string nested in a string, inside multi-line strings.
* **Pass condition:** no canary in any output, redaction terminates within a time bound (`expect(ms).toBeLessThan(200)`), and the original object is not mutated.

## 2. Client-IP & proxy spoofing (AREA = IP)
Use Supertest with forged `X-Forwarded-For` (`"1.1.1.1, 2.2.2.2"`, garbage, 10 KB header), `Forwarded: for=`, `X-Real-IP`, under trust proxy `false`/`true`/`1`/CIDR. Assert the limiter key and audit-log IP follow Express's `req.ip` semantics exactly and can't be chosen by the client when trust proxy is `false` or exact.

## 3. Rate-limiter bypass (AREA = RL)
* Rotate IPv6 addresses within one /64: they must share a bucket.
* Username case and whitespace variants on login keys (`Admin`, ` admin`).
* Concurrency: 200 parallel requests at the limit, so atomicity holds (count ≤ limit + 0).
* Store outage mid-burst under fail-open and fail-closed. Store latency above the timeout.
* Window boundaries with fake timers. Memory store under 1M unique keys stays bounded (eviction works).

## 4. Resource exhaustion / DoS (AREA = DOS)
* Middleware: oversized bodies → 413 before the full body is buffered; deeply nested JSON; 1 MB headers.
* Regex: for every regex applied to untrusted input, a worst-case string of 50k chars must finish in < 50 ms.
* Scanner: 50 MiB file, 100k tiny files, a 1 MB single-line minified file, deep directories. Limits trigger, and the report says so.

## 5. Scanner safety (AREA = SCAN)
* Symlinks pointing outside the root (`../../etc`, absolute paths, Windows junctions where possible), `..` in configured paths, a path that differs only in case on case-insensitive FS. Nothing outside the root is read (spy on `fs` or use a canary file outside the root).
* **No execution:** a fixture project whose files would write a marker file or exit the process if executed (`process.exit(99)`, `require("fs").writeFileSync(marker)`) at top level, in `postinstall`, or in a `.js` config file. After a scan: marker absent, process alive.
* Malformed package.json, a BOM, binary files, invalid UTF-8.

## 6. Config & prototype pollution (AREA = CFG)
JSON config with `{"__proto__": {"polluted": true}}`, `constructor.prototype`, nested in rule options. Afterwards `({}).polluted === undefined`, and Zod rejects or strips the keys.

## 7. Output injection (AREA = OUT)
* Evidence that contains ANSI escapes (`\u001b[2J`, OSC 8 hyperlinks) or `\r` must be escaped in text output and never interpreted by the terminal.
* JSON/SARIF output stays valid JSON for any finding text (quotes, U+2028, lone surrogates).
* `--output` paths: an existing symlink target, a directory, and a path in a non-existent directory each behave as documented, and the write is atomic.

## 8. CLI abuse (AREA = CLI)
Unknown flags, `--fail-on` with invalid values, huge argv, `--config` pointing to `/dev/zero` or a FIFO or a directory → exit 2 with a one-line error, no stack trace unless `--debug`.

## 9. Supply chain (AREA = SUP) — run, don't just read
```bash
npm audit --omit=dev --json | node -e "const r=JSON.parse(require('fs').readFileSync(0));console.log(r.metadata.vulnerabilities)"
npm audit signatures 2>&1 | tail -5            # registry signatures + provenance attestations
npm query ":attr(scripts, [postinstall])" --json | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).map(p=>p.name))"
npm pack --dry-run -w <pkg> 2>&1 | tail -30     # no tests/fixtures/.env shipped
```
Lockfile check: every `resolved` URL is on `https://registry.npmjs.org/` (`grep -c '"resolved": "https://registry.npmjs.org/' package-lock.json` vs. total resolved entries).

## Reporting a confirmed weakness
`SEC id · file:line · input that triggers it · impact · severity (critical/high/medium/low) · failing test name · suggested fix`. Report critical items at once to the lead. Do **not** open public issues for undisclosed vulnerabilities (see SECURITY.md).
