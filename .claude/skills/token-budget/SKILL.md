---
name: token-budget
description: Usage-saving rules for the owner's 5-hour limit — when to spawn agents vs work inline, which model per role, how to read/run things cheaply. Use at the start of any multi-step task and whenever planning delegation.
---

# Token budget

## Decide: inline or agent?
| Situation | Do |
|---|---|
| ≤3 tool calls, or a question one Grep answers | inline, no agent |
| One focused change in one package | 1 specialist (+ qa) |
| Independent pieces (e.g. docs + CI) | parallel specialists, one message |
| Security-sensitive diff | add security-reviewer (opus) — once, at the end, not per iteration |
| Pure prose (README, community files) | docs-community (haiku) |

## Reading
* Glob → Grep (`output_mode: files_with_matches`) → Read with `offset/limit`. Never Read lockfiles, `dist/`, `coverage/`, `node_modules/`.
* Quote BLUEPRINT by section number in briefs instead of pasting it.

## Running
* `npx vitest run <file> --reporter=dot 2>&1 | tail -15`; `npm run build 2>&1 | tail -10`.
* Don't run the full OS×Node matrix locally; push and read CI's summary.
* Long installs/builds: `run_in_background` and keep working.

## Writing
* Agents return ≤150-word reports, `file:line` refs, no pasted code or full logs.
* Lead's owner report ≤15 lines.
* Don't re-read a file you just wrote.

## Stop rules
* Same failure twice with the same approach → change approach or ask; no third blind retry.
* A brief that needs >200 words means the task is too big — split it.
