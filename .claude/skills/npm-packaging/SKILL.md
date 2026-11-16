---
name: npm-packaging
description: npm workspaces and publishable-package engineering for Bug-Free Eureka — root/package package.json fields, ESM+CJS exports maps, tsup builds, internal workspace dependencies, peer dependencies, publint/attw validation, Changesets config, and npm trusted publishing with provenance. Use when creating or changing any package.json, build config, or release setup.
---

# npm packaging

npm latest on 2026-11-16: tsup 9.0, @changesets/cli 3.0, typescript 7.0. Pin exact devDependency versions and commit `package-lock.json` (`npm ci` needs it).

## Root package.json
`private: true`, `workspaces: ["packages/*"]`, `engines.node: ">=22 <27"`, `packageManager: "npm@<x.y.z>"`, scripts from BLUEPRINT §11, `devEngines` optional. No `os`/`cpu` fields.

## Publishable package.json template
```jsonc
{
  "name": "@bug-free-eureka/core", "version": "0.0.0", "license": "Apache-2.0",
  "description": "…", "repository": { "type": "git", "url": "git+https://github.com/bitsaspidy/bug-free-eureka.git", "directory": "packages/core" },
  "type": "module", "sideEffects": false, "engines": { "node": ">=22 <27" },
  "exports": {
    ".": {
      "import":  { "types": "./dist/index.d.ts",  "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    },
    "./package.json": "./package.json"
  },
  "main": "./dist/index.cjs", "types": "./dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": { "access": "public", "provenance": true },
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit -p tsconfig.json" }
}
```
* `types` comes **first** inside each condition. Each format gets its own `.d.ts`/`.d.cts`.
* Copy `LICENSE` into each package at build or prepack time (npm doesn't include the root one).
* No `postinstall` or other install scripts, ever.

## tsup.config.ts
```ts
export default defineConfig({ entry: ["src/index.ts"], format: ["esm", "cjs"], dts: true, clean: true,
  sourcemap: true, target: "node22", platform: "node", splitting: false, treeshake: true });
```
The CLI adds `banner: { js: "#!/usr/bin/env node" }` and can be ESM-only (a bin doesn't need CJS). If tsup's dts step doesn't work with the installed TS major, record an ADR (options: pin TS, use `tsc --emitDeclarationOnly`, or tsdown).

## Internal dependencies
npm **doesn't support** `workspace:*`. Use a normal range (`"@bug-free-eureka/core": "^0.1.0"`). npm links the local workspace when the version satisfies it, and Changesets bumps the ranges (`updateInternalDependencies: "patch"`).

## Peer / optional dependencies
* `@bug-free-eureka/express`: `peerDependencies.express: "^4.21.0 || ^5.0.0"`, with express in devDependencies for tests.
* No Redis client dependency at all. The store accepts any client with `eval`. Document `ioredis`/`redis` usage in examples (examples have their own package.json and aren't workspaces).

## Validation before every release (and in CI)
```bash
npm run build && npm pack --dry-run -w packages/core          # only dist/, README, LICENSE, package.json
npx publint packages/core                                       # exports/fields lint
npx @arethetypeswrong/cli --pack packages/core                  # types resolve for import + require
```
Plus a smoke test in a temp dir: `npm pack`, install the tarball, then `require()` and `import()` it.

## Changesets (`.changeset/config.json`)
`{ "baseBranch": "main", "access": "public", "updateInternalDependencies": "patch", "commit": false, "fixed": [], "linked": [["@bug-free-eureka/*"]], "ignore": [] }`. Pre-1.0: breaking changes go in a minor bump and the changeset text says "BREAKING". A PR changing a package without a changeset fails `changeset status` in CI.

## Trusted publishing (OIDC)
* The release job runs Node ≥22.14 with npm ≥11.5.1 (`npm i -g npm@^11.5.1` if needed), `permissions: id-token: write`, and `environment: npm-release`.
* The owner configures a trusted publisher per package on npmjs.com (repo `bitsaspidy/bug-free-eureka`, workflow file `release.yml`, environment `npm-release`). If npm requires the package to exist first, the owner does a one-time manual 2FA publish of a placeholder. Check npm's docs at that time; don't assume.
* No `NPM_TOKEN` secret. Provenance is produced automatically under trusted publishing.
* Scope `@bug-free-eureka` must be owned by the owner's npm org before the first publish. Verify with `npm view @bug-free-eureka/core` / `npm org ls`.
