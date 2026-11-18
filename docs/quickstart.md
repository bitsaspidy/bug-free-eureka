# Quickstart

This walks you through one audit that fails, one fix, and the audit passing. It takes about five minutes.

::: warning Not on npm yet
Bug-Free Eureka is not published to npm. You build it from the repository. Do not run `npx bug-free-eureka` to fetch it: no package by that name is published.
:::

## 1. Build the CLI

You need Node.js 22, 24 or 26, npm 11 and Git. The commands work in bash, zsh and PowerShell.

```bash
git clone https://github.com/bitsaspidy/bug-free-eureka.git
cd bug-free-eureka
npm ci
npm run build
```

The CLI is now at `packages/cli/dist/bin.js`.

## 2. Run the example audit

The repository ships an example project in `examples/quickstart`. It holds a config file and one evidence file. There is no app code: the CLI only reads JSON.

```bash
cd examples/quickstart
node ../../packages/cli/dist/bin.js audit
```

The report starts like this (shortened):

```text
Bug-Free Eureka 0.0.0 audit
Summary: 1 failed, 0 warnings, 3 not assessed, 0 passed

FAIL [high] BFE-006 Unsafe trusted-proxy configuration
  evidence: declared topology: single-proxy, declared hops 1; directExposure: no; forwardedHeaderHandling: append
  ...
NOT ASSESSED (not a pass) BFE-001 Missing recommended security headers
  missing: input invalid: (root)
```

The exit code is `1`, because a `high` finding failed (check it with `echo $?` in bash or `$LASTEXITCODE` in PowerShell).

What happened:

- **BFE-006 failed.** The evidence file `security/bfe-006.json` says the app sets `trust proxy` to `true` behind one proxy that *appends* to `X-Forwarded-For`. With `true`, Express takes the left-most address, which the client controls, so any client can pick its own `req.ip`.
- **BFE-001, BFE-003 and BFE-005 are not assessed.** They are enabled but have no evidence file. Not assessed is never a pass.

The config, `bug-free-eureka.config.json`:

<<< @/../examples/quickstart/bug-free-eureka.config.json

The evidence, `security/bfe-006.json`:

<<< @/../examples/quickstart/security/bfe-006.json

## 3. Fix it and audit again

In the app, the fix is `app.set("trust proxy", 1)`: trust exactly the one proxy you run. In the evidence file, change the `value` line to:

```json
"value": { "kind": "hops", "hops": 1 },
```

The example also ships the fixed file, `security/bfe-006-fixed.json`, and a config that uses it. To try it without editing:

```bash
node ../../packages/cli/dist/bin.js audit --config bug-free-eureka.fixed.json
```

```text
Summary: 0 failed, 0 warnings, 3 not assessed, 1 passed
```

The exit code is `0`. To also fail on rules you have not given evidence for, add `--fail-on-unassessed` (the exit code becomes `1`).

## 4. Use it in your own project

From your project's root folder (replace `<repo>` with the path to your clone):

```bash
node <repo>/packages/cli/dist/bin.js init
node <repo>/packages/cli/dist/bin.js audit
```

`init` writes `bug-free-eureka.config.json` with all four rules enabled. It then suggests `npx bug-free-eureka audit`; until the CLI is on npm, run the `node <repo>/...` command above instead. The first audit reports four rules as not assessed. Then write an evidence file for each rule you want checked. Each rule page describes its input in section 2.1:

- [BFE-001 Security headers](/rules/BFE-001)
- [BFE-003 Request-size limit](/rules/BFE-003)
- [BFE-005 Sensitive logging](/rules/BFE-005)
- [BFE-006 Trusted proxy](/rules/BFE-006)

Next: [CLI reference](/cli), [configuration](/configuration), and [what the toolkit does not do](/limitations).
