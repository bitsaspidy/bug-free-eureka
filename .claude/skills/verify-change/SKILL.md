---
name: verify-change
description: Independent QA verification of a Bug-Free Eureka branch or PR — new tests fail without the change and pass with it, full suite, typecheck, lint, build, coverage on rule logic, package contents, ESM+CJS import, CLI exit codes, secret-free outputs. Use when a change is ready for review, before the owner merges.
---

# Verify a change

The author's own test run is evidence, not verification.

## 0. Target
`git fetch origin <branch>` and check out detached. Note the short SHA. Read the PR/brief: what it claims and which tests prove it.

## 1. Tests prove the fix
For changed source files: put `origin/main` versions in place (`git show origin/main:<p> > <p>`), run only the new tests → the relevant ones must **fail**. Restore (`git checkout -- .`) → must **pass**. `git status` clean afterwards. (New package with no `main` version: skip, say so.)

## 2. Full local checks (tail outputs)
```bash
npm ci 2>&1 | tail -3
npm run lint 2>&1 | tail -5
npm run typecheck 2>&1 | tail -5
npm run test:coverage -- --reporter=dot 2>&1 | tail -25
npm run build 2>&1 | tail -5
```
Coverage: branch % for `packages/core/src/rules/**` must be ≥90.

## 3. Rule-specific (if rules changed)
Every changed rule has pass / fail / not_assessed / adversarial fixtures and a determinism test. Missing → NOT READY.

## 4. Package & runtime (if package config or exports changed)
* `npm pack --dry-run -w <pkg> 2>&1 | tail -30` → only dist, README, LICENSE, package.json.
* `node -e "require('<pkg>')"` and `node --input-type=module -e "import('<pkg>')"` from a temp dir after `npm pack` + install.
* CLI: run each documented exit code path; compare with docs.

## 5. Secrets
Run the `redaction-check` skill's grep over test outputs and generated reports.

## 6. Report (return to lead; lead pastes in PR)
```
QA — <branch> @ <sha>  (local: <os>, node <v>)
Fails without fix: yes/no/n.a.   Passes with fix: yes/no
lint / typecheck / build: ok|FAIL
tests: <n> passed, <n> failed   rule branch coverage: <x>%
fixtures pass/fail/n.a./adversarial: complete|missing <ids>
pack contents: ok|FAIL|n.a.   ESM+CJS: ok|FAIL|n.a.   exit codes: ok|FAIL|n.a.
secrets in outputs: none|FOUND <where>
CI matrix: <status or "no PR yet">
Not checked: <list>
Verdict: READY FOR OWNER | NOT READY (<reason>)
```
Never approve or merge.
