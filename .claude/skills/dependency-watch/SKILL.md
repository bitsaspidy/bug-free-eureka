---
name: dependency-watch
description: Check Bug-Free Eureka's dependencies and dev tools for newer versions and decide whether they are safe and compatible — Node 22/24/26 engines, peer dependencies, lock-step plugin groups (TypeScript ↔ typescript-eslint ↔ tsup, Vitest ↔ @vitest/*, ESLint, Express ↔ @types), advisories, deprecations, release age and install scripts — then write an owner-ready upgrade proposal. Use weekly, before releases, when Dependabot opens PRs, or when the owner asks "any updates?".
---

# Dependency watch

## 1. Collect (one command, compact)
```bash
node scripts/dev/dep-report.mjs              # markdown table
node scripts/dev/dep-report.mjs --json       # machine-readable
```
For each direct dependency in the root and `packages/*/package.json`, it reports: declared range, installed version, latest version, bump type, whether the latest version's `engines.node` covers 22/24/26, peer-dependency conflicts with our other dependencies, deprecation, days since release, and an `npm audit` summary. It doesn't install anything.

## 2. Judge (what the script can't)
**Lock-step groups.** Upgrade them together or not at all:
| Group | Constraint |
|---|---|
| `vitest`, `@vitest/coverage-v8`, `@vitest/*` | identical versions |
| `typescript` ↔ `typescript-eslint` ↔ tsup's dts build ↔ `@arethetypeswrong/cli` | the TS version must be inside typescript-eslint's supported range, and tsup dts must build; TS 7 (native) needs explicit confirmation |
| `eslint` ↔ `typescript-eslint` ↔ eslint plugins | peer ranges satisfied |
| `express` ↔ `@types/express` ↔ `supertest`/`@types/supertest` | types major matches the runtime major we test |
| `@types/node` | major = **lowest** supported Node (22), so we don't use APIs missing on 22 |
| `@changesets/cli` ↔ `@changesets/*` | same major |
| `vitepress` ↔ `vue` | vitepress peer range |

**Node engines — dev vs runtime.** Default targets are the *lowest* minor we test (22.12.0, 24.0.0, 26.0.0).
* A **runtime** dependency (`dependencies`/`peerDependencies` of a published package) must cover the whole user range `>=22 <27`. A `RUNTIME engines exclude` flag means blocked, or the owner raises our `engines` floor (a breaking change).
* A **dev** tool (tsup, eslint, vitest…) may need a newer minor (e.g. tsup 9 needs `^22.18.0 || ^24.11.0`). That's acceptable only if CI uses the latest minor of each line and CONTRIBUTING/`.nvmrc` state the minimum dev Node. Record the new dev minimum in the proposal.

**Runtime vs dev.** Runtime dependencies of published packages get extra scrutiny: maintainer activity, provenance (`npm view <pkg>@<v> dist.attestations`), install scripts (`npm view <pkg>@<v> scripts`), and package size. A new runtime dependency is a security-reviewer decision.

**Majors.** Read the release notes or changelog (WebFetch the project's GitHub releases page). List the breaking changes that affect us, using Grep on our code to check whether we use the changed APIs.

**Cooldown.** Versions younger than 14 days are "wait", unless they fix an advisory that affects us. This guards against compromised releases, which are usually caught within days.

**Advisories.** Check `npm audit` plus the GitHub Advisory Database for the package (`https://github.com/advisories?query=<pkg>`). Severity alone isn't enough: say whether our usage is affected.

## 3. Propose (owner decides)
```
Dependency report — <date> (Node targets 22/24/26)
| Package | Current | Proposed | Type | Node 22/24/26 | Peers | Age | Advisories | Action |
|---|---|---|---|---|---|---|---|---|
| vitest + @vitest/coverage-v8 | 5.0.2 | 5.1.0 | minor | ✓✓✓ | ✓ | 21d | none | upgrade |
| typescript | 6.x | 7.0.2 | major | ✓✓✓ | ✗ typescript-eslint <ver> supports ≤6 | 40d | none | blocked by typescript-eslint |
Security fixes (do now): …
Blocked / waiting: …
Owner decision needed: …
```
Actions: `upgrade` · `upgrade with code changes (<files>)` · `wait (cooldown until <date>)` · `blocked by <pkg>` · `skip (reason)`.

## 4. Apply (not you)
After the owner approves: devops-release does the upgrade on a branch `deps/<date>` (`npm install <pkg>@<exact>` for each group, then `npm ci` clean), qa-engineer runs `verify-change`, and CI runs the full OS × Node matrix. A failed matrix cell means no merge.

## Rules
Never edit package.json or the lockfile yourself. Never `npm update` blindly. Never recommend `--force` or `--legacy-peer-deps` to hide a peer conflict; report the conflict instead.
