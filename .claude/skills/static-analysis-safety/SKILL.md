---
name: static-analysis-safety
description: How the Bug-Free Eureka auditor inspects a project safely and accurately — evidence sources, parsing JS/TS without executing it, detecting Express configuration patterns with confidence levels, file walking limits, path containment, symlinks, secret masking and deterministic output. Use when building the scanner/evidence collectors in packages/core or designing what a rule can observe.
---

# Safe static analysis

## Evidence sources (in order of reliability)
1. **Declared config**: `bug-free-eureka.config.json` → `deployment` block (proxy in front? which headers does it add? TLS terminated where? number of instances?). This is the user's statement: confidence high, `source: "config"`.
2. **package.json / lockfile**: dependencies present (`helmet`, `cors`, `express-rate-limit`, `express-session`) and versions. Presence is a hint, not proof of use: confidence low.
3. **Source AST**: literal call patterns in app code. Confidence depends on how literal the value is.
4. **Optional proxy config files** the user points to (nginx.conf, Apache vhost), parsed for specific directives only.
Never: network probes (unless the user explicitly enables a future `--target-url` with authorization), running the app, or importing modules.

## Parsing without executing
* Parse to an AST with a pure-JS parser that handles TS and JSX. The choice is an **ADR in WO-002**. Candidates: `@babel/parser` (pure JS, TS+JSX plugins, error recovery) or the TypeScript API `createSourceFile` (heavy runtime dependency). Native parsers violate the "no native deps" rule.
* Parse with `errorRecovery`. An unparseable file becomes evidence "file could not be parsed" and leads to `not_assessed` for rules that depended on it.
* Never `require`, `import()`, `vm`, `eval`, `child_process` or `Function` on project files. Security-reviewer blocks any PR that does.

## Pattern detection & confidence
| Pattern seen | Meaning | Confidence |
|---|---|---|
| `app.set("trust proxy", true)` literal | trust proxy = all | high |
| `app.set("trust proxy", process.env.X)` / variable | value unknown | → `not_assessed`, evidence names the variable |
| `app.use(helmet())` on the app object | headers set by helmet | medium (options/order may disable some) |
| `express.json({ limit: "50mb" })` | explicit limit | high |
| `express.json()` | default 100kb | high |
| Setup spread across modules / router factories | partial view | lower one level; say so in evidence |
* Track the Express app identifier: `const app = express()`, `export default express()`, and `Router()` instances. Unresolved aliases mean `not_assessed`.
* "Not seen" is **not** "absent" when files were skipped, unparsed, or the app is built dynamically. The rule must check the scan coverage in `ctx` before returning `fail`.

## File walking limits (defaults, configurable within caps)
* Root = the resolved `--cwd`. Skip `node_modules`, `.git`, `dist`, `build`, `coverage`, plus `.gitignore` entries (simple glob subset).
* Max file size 1 MiB, max files 5,000, max directory depth 20, total time budget 30 s via `AbortSignal`. Each limit hit is recorded in the report's `scanScope` notes and lowers the coverage flag.
* Use `lstat`; **don't follow symlinks** by default. When following is enabled, `realpath` then a containment check:
  ```ts
  const rel = path.relative(rootReal, targetReal);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  ```
  (Compare case-insensitively on win32/darwin.)
* Skip binary files (NUL byte in the first 8 KiB). Strip a BOM. Accept CRLF.
* Sort the file list deterministically before processing. Output paths are POSIX-relative.

## Secrets found during analysis
A hard-coded secret-looking literal (session secret, JWT secret, API key pattern) is reported by **location and kind only**, `detail: "string literal assigned to session secret (value masked)"`. Never include the value, a prefix, a suffix or its hash.

## Performance
Read files with bounded concurrency (e.g. 8). Parse each file once and share the AST across rules via a per-scan cache. Rules never re-read files.

## Testing the scanner
Fixture projects in `tests/fixtures/projects/<name>/`. Adversarial cases: a symlink to `/etc` or outside the root, a 50 MiB file, deep nesting, a file with a syntax error, a minified file with a 1 MB line, the same file reachable twice, and a file named with unicode or spaces. Each one must terminate quickly, stay inside the root and report its limits honestly.
