# Bug-Free Eureka — rules for every Claude session and agent

Open-source API security & configuration toolkit for Node.js (Express first). Apache-2.0. Owner: **Devavrat Singh (@bitsaspidy)**, the final authority. Nothing reaches `main` without the owner's merge; nothing is published to npm without the owner's approval.

Spec: `docs/BLUEPRINT.md` (read only the section you need). Progress: `docs/WORK_ORDERS.md`. Team: `docs/AI_TEAM.md`.

## 1. Product rules (never broken)
1. **Runs inside the user's app.** Core SDK: no own HTTP server, no mandatory DB/Redis/Docker/cloud/API key, no port change, no root, no migrations, no route rewrites, no silent production changes.
2. **`packages/core` never imports Express** (or any framework). CLI uses core only through its public API. Adapters are independently installable.
3. **Deterministic rules.** Same input → same findings. No network, no clock, no randomness inside rule logic (inject `now` if needed).
4. **Unknown ≠ pass.** A rule that cannot establish the facts returns `not_assessed`. Never assume what a reverse proxy/CDN does when its config was not supplied.
5. **Never execute scanned code.** Static audit = parse/read only, with file-size and path-traversal limits. Remote scanning off unless explicitly configured and authorized.
6. **No secrets in output.** Reports, logs, errors and test snapshots must never contain tokens, passwords, cookies, OTPs or auth headers.
7. **Honest claims.** No "secure"/"bug-free"/"OWASP compliant" guarantees. Platform support is claimed only after CI proves it. Severities are defaults, not risk judgments.
8. **Portable.** Node 22/24/26 on Linux, Windows, macOS. Use `node:path`, no shell-specific scripts in package code, no native deps without a documented reason. `engines: ">=22 <27"`, no `os` field.
9. **ESM + CJS** via explicit, tested `exports` conditions.

## 2. Engineering rules
* TypeScript strict. Zod for input validation. Vitest + Supertest. tsup build. Changesets for versions.
* Every rule ships with **pass, fail and not_assessed fixtures** and a `docs/rules/BFE-XXX.md` page. Security rule logic targets ≥90% branch coverage.
* Errors: typed error classes, actionable messages, never swallow silently; CLI maps errors to documented exit codes.
* Dependencies: minimal, well-maintained; justify every new runtime dependency in the PR.
* GitHub Actions: pin actions to full commit SHAs, least-privilege `permissions`, no publish credentials in PR jobs, npm trusted publishing (OIDC) only.

## 3. Workflow
* One work order (WO) or rule per branch, from `main`. Branch names: `feat/BFE-001-…`, `fix/…`, `test/…`, `docs/…`, `ci/…`. (Cloud sessions may be required to use an assigned `claude/…` branch — that wins.)
* Draft PR against `main`, filled from `.github/PULL_REQUEST_TEMPLATE.md` once it exists. Stage files by name, never `git add -A`.
* **Every work order updates `README.md` in the same PR** (owner rule): rule/package status tables, badges, compatibility and status notes, whatever that WO changed. Edit only the lines your WO affects, and keep claims honest (§1.7). That includes the README **Work-order status** table: set your WO to 🔄 In progress, and set any WO whose PR has since merged to ✅ Done (same in `docs/WORK_ORDERS.md`).
* Parallel sessions sharing one checkout: each works in its own `git worktree` (e.g. `git worktree add -b <branch> ../bfe-<wo> origin/main`); never switch branches in a shared checkout.
* **No agent merges, publishes, changes repository settings, or edits `LICENSE`.** Security-sensitive changes need the owner's review.
* Undisclosed vulnerabilities are never discussed in public issues.

## 4. Token & usage budget (the owner has a 5-hour usage limit — respect it)
* Do it inline if it takes ≤3 tool calls. Spawn an agent only for real, separable work.
* Grep/Glob before Read; read line ranges, not whole files; never dump large outputs (`| tail -20`, `--reporter=dot`).
* Briefs to agents ≤200 words; agent reports ≤150 words with `file:line` evidence, no pasted code.
* Run independent agents in parallel; never re-run a full test matrix locally — CI does that.
* Prefer skills (`.claude/skills/`) over re-explaining procedures. Cheaper models for cheaper roles (see `docs/AI_TEAM.md`).
