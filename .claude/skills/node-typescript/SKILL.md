---
name: node-typescript
description: Node.js 22/24/26 + TypeScript engineering standards for Bug-Free Eureka — tsconfig, ESM source, dual ESM/CJS hazards, Zod validation, typed errors and error boundaries, async safety, cross-platform paths, prototype-pollution and ReDoS safety, performance. Use when writing or reviewing any TypeScript in packages/.
---

# Node.js + TypeScript standards

Versions seen on npm 2026-11-16: typescript 7.0 (native Go compiler), zod 4.6. Pin exact dev versions in WO-001. If a tool that uses the TS JS API (tsup dts, typescript-eslint) doesn't support TS 7 yet, pin the newest TS it supports and record that in an ADR.

## tsconfig.base.json (essentials)
```jsonc
{ "compilerOptions": {
  "target": "ES2023", "lib": ["ES2023"], "module": "NodeNext", "moduleResolution": "NodeNext",
  "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true, "noFallthroughCasesInSwitch": true, "useUnknownInCatchVariables": true,
  "verbatimModuleSyntax": true, "isolatedModules": true, "declaration": true, "sourceMap": true,
  "skipLibCheck": true, "forceConsistentCasingInFileNames": true, "types": ["node"] } }
```
* Source is ESM. Relative imports carry `.js` (`import { x } from "./x.js"`) under NodeNext. Use `import type` for types only.
* Built-ins always use the `node:` prefix (`node:fs/promises`, `node:path`, `node:url`).
* No `any` in public types. Use `unknown` and narrow it. Exported types are part of SemVer.

## Dual ESM/CJS hazards
* No module-level mutable singletons; a package loaded as both ESM and CJS gets two copies.
* Never rely on `instanceof` across the package boundary. Detect errors by `err.code` (string) instead.
* `require(esm)` works unflagged on Node 22.12+, but we still ship CJS. Test both entry points.

## Errors and error boundaries
```ts
export class BfeError extends Error {
  constructor(readonly code: BfeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options); this.name = "BfeError";
  }
}
// codes: E_CONFIG_INVALID, E_INPUT_INVALID, E_FILE_LIMIT, E_PATH_OUTSIDE_ROOT, E_RULE_CRASH, E_STORE_UNAVAILABLE …
```
* Throw only `Error` subclasses with a stable `code`. Keep the original error in `cause`.
* Messages say what failed and how to fix it, and **never include input values** (they may be secrets).
* Engine boundary: one crashing rule must not abort the scan. Catch per rule and emit a `not_assessed` finding with code `E_RULE_CRASH`. Never report a crash as `pass`.
* Never use an empty `catch {}`. A deliberate ignore gets a comment explaining why.
* Public async APIs reject with a `BfeError`. They never throw synchronously or leave a promise floating (enable the `no-floating-promises` lint rule).

## Validation (Zod 4)
* Validate at every public boundary: config, rule input, CLI args, middleware options. Use `schema.safeParse(x)`.
* Use `z.strictObject` for config (unknown keys → error, which catches typos), and `.default()` for documented defaults.
* Map issues to `path` + `message`, and **drop `input`/`received` values** before surfacing them.
* Generate the report JSON Schema with `z.toJSONSchema(reportSchema)` so it can't drift.

## Security in code
* **Prototype pollution:** merge config only from validated objects. Reject the keys `__proto__`, `constructor` and `prototype`. Use `Object.create(null)` for maps keyed by input, or use `Map`.
* **ReDoS:** regexes over untrusted input must be linear: no nested quantifiers `(a+)+` and no overlapping alternation. Cap input length before matching. Precompile regexes at module level.
* **Never** `eval`, `new Function`, `vm`, `child_process`, or dynamic `import()`/`require()` of user paths.
* Masking helper `mask(value)` returns `"****"` (optionally with the length). Never log partial secrets.

## Async and performance
* Bound long operations: `AbortSignal.timeout(ms)` and pass `signal` through.
* Middleware hot paths must not use sync fs or JSON-stringify big objects per request. Precompute config at factory time.
* Use `structuredClone` for defensive copies of small config objects, and freeze returned defaults.
* Avoid unbounded arrays and queues. Every buffer has a cap and a documented overflow behavior.

## Cross-platform
* Build paths with `path.join`/`path.resolve`. Convert URLs with `fileURLToPath(new URL("./x", import.meta.url))`.
* Reports show **POSIX-relative** paths (`path.relative(root, p).split(path.sep).join("/")`) so they're the same on Windows.
* Windows and macOS filesystems may be case-insensitive. Compare paths for containment after `realpath`.
* Parse text tolerating CRLF and a BOM (`s.replace(/^﻿/, "")`, split on `/\r?\n/`).
* Sort with `a < b ? -1 : a > b ? 1 : 0` (locale-independent), never `localeCompare`, so output is deterministic.

## Library hygiene
* Libraries never call `console.*` or `process.exit`. They accept an injected logger or sink. Only the CLI writes to stdio.
* No top-level side effects (`sideEffects: false` must stay true).
* Every new runtime dependency needs a justification in the PR. Prefer Node built-ins.
