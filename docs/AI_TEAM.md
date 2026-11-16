# Bug-Free Eureka — AI development team

9 roles, led by `eureka-lead`, reporting to the owner **Devavrat Singh (@bitsaspidy)**, the final authority. Every role obeys `CLAUDE.md` first. Designed for the owner's 5-hour usage limit: small team, cheap models where quality allows, skills instead of repeated instructions.

## Roles
| Agent | Owns | Writes | Model |
|---|---|---|---|
| `eureka-lead` | scope, plan, delegation, decisions, PRs, owner report | process docs only | session model |
| `rule-analyst` | rule specs `docs/rules/BFE-xxx.md` with decision tables & verified references | specs | sonnet |
| `core-engineer` | `packages/core` — engine, rules, redaction, reports | code + tests | sonnet |
| `integrations-engineer` | `packages/express`, `packages/cli`, `examples/` | code + tests | sonnet |
| `qa-engineer` | independent verification, missing tests, READY verdict | tests only | sonnet |
| `security-reviewer` | security review of sensitive diffs & releases | nothing (read-only) | opus |
| `security-tester` | runs attacks on our own code (SEC-xxx tests) + dependency watch & upgrade proposals | security tests only | sonnet |
| `devops-release` | tooling, workspaces, exports, GitHub Actions, Changesets, npm OIDC | config + workflows | sonnet |
| `docs-community` | README, docs/, community & sponsor files | docs | haiku |

## Routing
| Task | Team (→ = sequence, + = parallel) |
|---|---|
| New rule BFE-xxx | rule-analyst → core-engineer → qa-engineer (+ security-reviewer if logging/proxy/secrets) |
| Core engine change | core-engineer → qa-engineer |
| Middleware / CLI | integrations-engineer → qa-engineer + security-reviewer |
| Tooling / CI / release | devops-release → qa-engineer (+ security-reviewer for workflows) |
| Docs / community | docs-community (lead reviews claims) |
| Bug fix | owner of the area → qa-engineer |
| Security-sensitive feature | … → qa-engineer + security-tester (attack tests) + security-reviewer (review) |
| Dependency updates ("any updates?", weekly, Dependabot PR) | security-tester (`dependency-watch` → proposal) → **owner approves** → devops-release applies → qa-engineer verifies |
| Release | `release-gate` skill: all roles supply evidence, owner approves; security-tester runs the full `security-testing` playbook |

## Skills
Project (`.claude/skills/`):
| Skill | Used by | Purpose |
|---|---|---|
| `work-order` | lead | WO/BFE lifecycle: scope → branch → delegate → verify → PR → board |
| `token-budget` | lead, all | inline-vs-agent, cheap reads/runs, report sizes |
| `add-rule` | core-engineer | rule file layout, shape, fixtures, mandatory tests |
| `verify-change` | qa-engineer | independent verification + report template |
| `redaction-check` | qa, security | canary secrets through every output path |
| `ci-hardening` | devops-release, security | SHA pinning, least privilege, OIDC publish |
| `release-gate` | lead | 9-point go/no-go with evidence |
| `security-testing` | security-tester | attack playbook: redaction bypass, IP spoofing, limiter bypass, DoS, scanner traversal/no-exec, pollution, output injection, CLI, supply chain |
| `dependency-watch` | security-tester | latest versions vs Node 22/24/26, peers & lock-step plugin groups, cooldown, advisories → upgrade proposal (uses `scripts/dev/dep-report.mjs`) |

Stack skills (the engineering know-how; preloaded where marked ●, otherwise loaded on demand ○):
| Skill | Covers | core | integ | qa | sec | devops | docs | rule | tester |
|---|---|---|---|---|---|---|---|---|---|
| `node-typescript` | Node 22–26, TS strict/NodeNext, dual ESM/CJS, Zod 4, typed errors & boundaries, pollution/ReDoS, cross-platform | ● | ● | | ○ | ○ | | | ○ |
| `express-middleware` | Express 4+5, trust proxy/req.ip, body limits, headers, CORS, cookies, rate limiting + Redis store, audit logger, Supertest | | ● | | ○ | | ○ | ● | ○ |
| `testing-vitest` | Vitest projects/coverage thresholds, table-driven rule tests, fake time, temp dirs, CLI tests, fast-check, pytest | ● | ● | ● | | ○ | | | ○ |
| `cli-sarif` | Commander, exit codes, JSON-only config, stdout/stderr, atomic writes, SARIF 2.1.0 mapping for GitHub | ○ | ● | | | | ○ | |  |
| `static-analysis-safety` | evidence sources, AST parsing without executing, confidence table, file-walk limits, symlinks, secret masking | ● | ○ | | ● | | | ○ | ○ |
| `npm-packaging` | workspaces, exports maps, tsup, internal deps (no `workspace:*` in npm), peers, publint/attw, Changesets, OIDC | ○ | ○ | | ○ | ● | ○ | | ○ |
| `docs-dashboard-python` | VitePress + Pages deploy, local-first React dashboard safety, Python validators with pytest | | | | | ○ | ● | |  |

Future role: `frontend-engineer` (React + Vite dashboard, v1.1+) is hired when that work starts. It will preload `docs-dashboard-python` and `testing-vitest`.

Built-in skills to lean on: `engineering:code-review` (lead, before PR), `security-review` (security-reviewer), `engineering:testing-strategy` (qa, new modules), `engineering:architecture` (ADRs in `docs/architecture/`), `engineering:documentation` (docs-community), `engineering:deploy-checklist` (release), `simplify` (after a feature lands).

## Start block (lead prints at the start of a task)
```
▶ WO-xxx <title> | team: <roles> | branch: <name> | done when: <acceptance>
```

## Hard limits for every agent
No merge, no `npm publish`, no repo-settings changes, no `LICENSE` edits, no finding-model contract change without the owner, no secrets in any output, no claims of platform support before CI proves it.

## Live agent view — http://localhost:4778 (Bug-Free Eureka only)
* `.claude/agent-view/server.js` is this repo's own read-only dashboard: working-now, team, recent activity, work orders. It reads **only this repo** (`.claude/agents/`, `.claude/agent-activity.log`, `docs/WORK_ORDERS.md`), so it can't show another project.
* Jyotish Stack keeps its own view on **:4777** (`~/.claude/agent-view`). This project never writes there, so the two can't mix.
* `.claude/hooks/ensure-agent-view.js` starts it on SessionStart and each prompt (desktop sessions only; skipped in CI/cloud). If 4778 is taken by something else it warns. Change it with `AGENT_VIEW_PORT`, disable it with `AGENT_VIEW=off`.
* Manual start: `node .claude/agent-view/server.js`. The page polls every 3 s and pauses when the tab is hidden.
* Security: binds 127.0.0.1, GET-only, Host allowlist plus cross-site block, strict CSP. `AGENT_VIEW_TRUST_HOST=1` relaxes the Host check **only** for an isolated cloud container behind the app's preview proxy.
* `.claude/hooks/agent-activity.js` appends every subagent start/stop to `.claude/agent-activity.log` (gitignored) and shows ▶/■ notices.

## How to run
* Main thread as lead: `claude --agent eureka-lead`, then e.g. "start WO-001".
* Or in any session: "use the eureka-lead workflow for WO-001".
* New role needed → lead writes `.claude/agents/<name>.md`, adds it here, includes it in the PR.
