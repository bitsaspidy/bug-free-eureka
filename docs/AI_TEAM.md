# Bug-Free Eureka — AI development team

8 roles, led by `eureka-lead`, reporting to the owner **Devavrat Singh (@bitsaspidy)**, the final authority. Every role obeys `CLAUDE.md` first. Designed for the owner's 5-hour usage limit: small team, cheap models where quality allows, skills instead of repeated instructions.

## Roles
| Agent | Owns | Writes | Model |
|---|---|---|---|
| `eureka-lead` | scope, plan, delegation, decisions, PRs, owner report | process docs only | session model |
| `rule-analyst` | rule specs `docs/rules/BFE-xxx.md` with decision tables & verified references | specs | sonnet |
| `core-engineer` | `packages/core` — engine, rules, redaction, reports | code + tests | sonnet |
| `integrations-engineer` | `packages/express`, `packages/cli`, `examples/` | code + tests | sonnet |
| `qa-engineer` | independent verification, missing tests, READY verdict | tests only | sonnet |
| `security-reviewer` | security review of sensitive diffs & releases | nothing (read-only) | opus |
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
| Release | `release-gate` skill: all roles supply evidence, owner approves |

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

Stack skills (the engineering know-how; preloaded where marked ●, otherwise loaded on demand ○):
| Skill | Covers | core | integ | qa | sec | devops | docs | rule |
|---|---|---|---|---|---|---|---|---|
| `node-typescript` | Node 22–26, TS strict/NodeNext, dual ESM/CJS, Zod 4, typed errors & boundaries, pollution/ReDoS, cross-platform | ● | ● | | ○ | ○ | | |
| `express-middleware` | Express 4+5, trust proxy/req.ip, body limits, headers, CORS, cookies, rate limiting + Redis store, audit logger, Supertest | | ● | | ○ | | ○ | ● |
| `testing-vitest` | Vitest projects/coverage thresholds, table-driven rule tests, fake time, temp dirs, CLI tests, fast-check, pytest | ● | ● | ● | | ○ | | |
| `cli-sarif` | Commander, exit codes, JSON-only config, stdout/stderr, atomic writes, SARIF 2.1.0 mapping for GitHub | ○ | ● | | | | ○ | |
| `static-analysis-safety` | evidence sources, AST parsing without executing, confidence table, file-walk limits, symlinks, secret masking | ● | ○ | | ● | | | ○ |
| `npm-packaging` | workspaces, exports maps, tsup, internal deps (no `workspace:*` in npm), peers, publint/attw, Changesets, OIDC | ○ | ○ | | ○ | ● | ○ | |
| `docs-dashboard-python` | VitePress + Pages deploy, local-first React dashboard safety, Python validators with pytest | | | | | ○ | ● | |

Future role: `frontend-engineer` (React + Vite dashboard, v1.1+) is hired when that work starts. It will preload `docs-dashboard-python` and `testing-vitest`.

Built-in skills to lean on: `engineering:code-review` (lead, before PR), `security-review` (security-reviewer), `engineering:testing-strategy` (qa, new modules), `engineering:architecture` (ADRs in `docs/architecture/`), `engineering:documentation` (docs-community), `engineering:deploy-checklist` (release), `simplify` (after a feature lands).

## Start block (lead prints at the start of a task)
```
▶ WO-xxx <title> | team: <roles> | branch: <name> | done when: <acceptance>
```

## Hard limits for every agent
No merge, no `npm publish`, no repo-settings changes, no `LICENSE` edits, no finding-model contract change without the owner, no secrets in any output, no claims of platform support before CI proves it.

## Activity log
`.claude/hooks/agent-activity.js` logs every subagent start/stop to `.claude/agent-activity.log` (gitignored) and shows ▶/■ notices.

## How to run
* Main thread as lead: `claude --agent eureka-lead`, then e.g. "start WO-001".
* Or in any session: "use the eureka-lead workflow for WO-001".
* New role needed → lead writes `.claude/agents/<name>.md`, adds it here, includes it in the PR.
