---
name: redaction-check
description: Prove no secret leaks from Bug-Free Eureka — seed canary secrets through findings, reports, logs, errors and the Express audit logger, then grep every output. Use for any change touching redaction, logging, evidence text, error messages or report formats, and before every release.
---

# Redaction check

## Canaries
Use unique strings that can't appear by accident:
```
BFE_CANARY_TOKEN_7f3a91   (Authorization: Bearer …)
BFE_CANARY_PASS_c02e44    (body.password, nested: body.user.credentials.password)
BFE_CANARY_COOKIE_9b11d5  (Cookie / Set-Cookie)
BFE_CANARY_OTP_448120     (body.otp)
BFE_CANARY_REFRESH_e5d7c2 (body.refreshToken, in an array element)
BFE_CANARY_ENV_a1b2c3     (process.env-like config value: DB_PASSWORD, API_KEY)
```
Vary placement: top level, nested 5+ deep, arrays, mixed-case keys (`PassWord`, `X-API-KEY`), JSON strings inside strings, Error messages, circular objects.

## Paths to exercise
1. Core rule evaluate → `JSON.stringify(report)`
2. Report writers: text, JSON, SARIF output files
3. Thrown/validation errors (`err.message`, `err.stack`, Zod issues)
4. Express `createAuditLogger` → capture sink output via Supertest request carrying all canaries
5. CLI `audit` stdout/stderr with `--debug` on and off

## Assert
```bash
grep -rEo "BFE_CANARY_[A-Z]+_[0-9a-f]{6}" <output-dir-or-captured-files> && echo "LEAK" || echo "clean"
```
In Vitest: `expect(output).not.toMatch(/BFE_CANARY_/)` for every captured string. Also assert redaction is **bounded** (deep/circular input doesn't hang or throw).

Any leak = critical finding, report immediately with path and input.
