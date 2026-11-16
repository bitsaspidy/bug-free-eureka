---
name: testing-vitest
description: Testing craft for Bug-Free Eureka with Vitest + Supertest (+ pytest for scripts/python) — config, projects, coverage thresholds, table-driven rule tests, fixtures, determinism, fake time, temp dirs, cross-platform assertions, CLI testing, property-based redaction tests. Use when writing or reviewing any test.
---

# Testing with Vitest

npm latest on 2026-11-16: vitest 5.1, supertest 7.3. Confirm the config keys against the installed Vitest major's docs; don't guess.

## Config (root `vitest.config.ts`)
* One config with per-package **projects** (`test.projects`), `environment: "node"`, `include: ["packages/*/tests/**/*.test.ts", "tests/**/*.test.ts"]`.
* Coverage: provider `v8`, reporters `text-summary` + `lcov`, include `packages/*/src/**`, and a glob threshold `"packages/core/src/rules/**": { branches: 90, lines: 90 }`.
* `restoreMocks: true`, `unstubEnvs: true`. No network: tests that need HTTP use Supertest against an in-process app.

## Rule tests (table-driven)
```ts
describe.each(loadFixtures("bfe-003"))("BFE-003 $name", ({ input, expected }) => {
  it("returns expected status", () => {
    const [f] = bfe003.evaluate(input, ctx);
    expect(f).toMatchObject({ status: expected.status, severity: expected.severity, confidence: expected.confidence });
  });
});
```
* Load fixtures with `JSON.parse(readFileSync(new URL("../fixtures/…", import.meta.url), "utf8"))`. Fixtures are data, never code.
* Every rule needs: fail, pass (false-positive guard), not_assessed, adversarial, and determinism (evaluate twice, then `toEqual`).
* Also assert on **evidence quality**: there's at least one evidence item, `detail` is non-empty, and no secret value appears in it.

## Determinism & time
* Inject `now`/clock through `ctx`. Use `vi.useFakeTimers()` only for timer-driven code (limiter windows) and `vi.advanceTimersByTime`.
* Never assert on `generatedAt`; inject a fixed time.

## Cross-platform
* Temp dirs: `await mkdtemp(join(tmpdir(), "bfe-"))`, removed in `afterEach` with `rm(dir, { recursive: true, force: true })`.
* Assert on POSIX-normalised paths. Never hard-code `/` or `\`.
* Symlink tests: `it.skipIf(process.platform === "win32" && !canSymlink)`. Document why; this is not a silent skip.
* Handle line endings: compare `text.replace(/\r\n/g, "\n")`.

## Express (Supertest)
* Build a fresh `express()` per test via a factory helper; never share app state between tests.
* Multi-instance: two apps sharing one store instance. A fake Redis-compatible store implements `eval` in memory and can be switched to "down" to test fail-open/closed.

## CLI
* Primary: in-process `await run(argv, { stdout, stderr, cwd, env })` returning the exit code. Capture the streams as strings.
* One smoke test spawns the built bin: `execFile(process.execPath, [binPath, "audit", "--format", "json"], { cwd: fixtureDir })`. Assert the exit code and that stdout parses as JSON.

## Redaction (property-based)
Optional dev dependency `fast-check`: generate nested objects with canary values under sensitive keys at random depths and casing, then assert no canary appears in the output and the function terminates (circular refs included).

## Snapshots
Use them only for stable, human-reviewed text output (terminal report). Sanitize times and paths. Never snapshot anything that might contain secrets.

## Python (scripts/python)
`pytest` with `python -I -m pytest scripts/python`. Fixtures are generated report JSON files. Python is never needed for `npm test`.

## Anti-patterns (reject in review)
Tests that only check "doesn't throw"; `expect(true)`; mocking the unit under test; sleeps instead of fake timers; order-dependent tests; skipping a failing test to get green.
