---
name: ci-hardening
description: Write or review Bug-Free Eureka GitHub Actions workflows safely — full-SHA pinning, least-privilege permissions, OS×Node matrix, CodeQL, dependency review, Dependabot, and an owner-approved npm trusted-publishing (OIDC) release. Use when adding or changing anything under .github/.
---

# CI hardening checklist

## Every workflow
- [ ] Top-level `permissions: contents: read`; widen per job only (`security-events: write` for CodeQL, `id-token: write` only in the publish job).
- [ ] Every `uses:` pinned to a **full 40-char commit SHA** with a `# vX.Y.Z` comment. Get SHAs from the action's releases (`git ls-remote https://github.com/<owner>/<action> refs/tags/<tag>`); never invent one. Unverifiable → `# TODO(owner): pin SHA`.
- [ ] No `pull_request_target` with checkout of PR code. No secrets in jobs triggered by `pull_request`.
- [ ] `actions/checkout` with `persist-credentials: false` unless the job pushes.
- [ ] `concurrency` group to cancel superseded runs (saves CI minutes).
- [ ] `timeout-minutes` on every job.
- [ ] No `${{ github.event.* }}` interpolated directly into `run:` — pass via `env:`.

## ci.yml
Matrix `os: [ubuntu-latest, windows-latest, macos-latest]` × `node: [22, 24, 26]`, `fail-fast: false`; steps `npm ci` → lint → typecheck → `test:coverage` → build. Use `shell: bash` where scripts need it (Windows). Upload coverage only from one cell.

## Security workflows
* `codeql.yml`: on PR, push to main, weekly cron; `language: javascript-typescript`.
* `dependency-review.yml`: on PR; `fail-on-severity: high`.
* `.github/dependabot.yml`: npm + github-actions, weekly, grouped minor/patch.

## release.yml
* Trigger: push to main (Changesets version PR) / manual `workflow_dispatch`.
* Publish job: `environment: npm-release` (owner adds required reviewer in settings), `permissions: id-token: write, contents: write`, Node ≥22.14 with npm ≥11.5.1, `npm publish --provenance` via trusted publishing — **no `NPM_TOKEN`**.
* Before publish: build, test, `npm pack --dry-run` content check.

## Owner-only settings to list in the report
Branch protection on `main` (required checks, reviews), `npm-release` environment reviewers, npm trusted publisher config per package, private vulnerability reporting, secret scanning, Dependabot alerts.
