# Contributing

Thanks for helping. Bug-Free Eureka is an early-stage project. Nothing here is released yet, and the APIs may change.

Read first:

- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md): report vulnerabilities privately, never in a public issue.
- `docs/BLUEPRINT.md`: the spec. `docs/WORK_ORDERS.md`: the status board.

## Who decides

Devavrat Singh ([@bitsaspidy](https://github.com/bitsaspidy)) is the final authority. Only the owner merges to `main` and approves npm publishes. Security-sensitive changes need the owner's review.

## Requirements

- Node.js `>=22 <27` (Node 22, 24 and 26 are the supported targets).
- npm (ships with Node).

## Setup

```sh
npm ci
```

Root scripts:

```sh
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:coverage
```

Run the same checks before you open a PR. CI runs the full OS and Node matrix. Do not rely on a local run for that.

## Branches and work orders

- One work order (WO) or one rule (BFE) per branch, cut from `main`.
- Names: `feat/BFE-001-short-name`, `fix/...`, `test/...`, `docs/...`, `ci/...`.
- Open a draft PR against `main`. Fill in [the PR template](.github/PULL_REQUEST_TEMPLATE.md).

## Commits and staging

- Stage files by name: `git add path/to/file`. Do not use `git add -A`.
- Keep commits focused. Use a short imperative subject.

## Code rules

- TypeScript in strict mode. Validate input with Zod.
- `packages/core` never imports Express or any other framework.
- Rules are deterministic: same input, same findings. No network, clock or randomness in rule logic.
- If a rule cannot establish the facts, it returns `not_assessed`. Unknown is never a pass.
- Never execute scanned code. Never put secrets, tokens, cookies or auth headers in output, logs, errors or snapshots.
- Every new dependency needs a reason in the PR.

## Adding a rule

Every rule needs all of the following in the same PR:

1. Fixtures for `pass`, `fail` and `not_assessed`.
2. Tests that use those fixtures.
3. A page at `docs/rules/BFE-XXX.md`.

Start with a [rule proposal](.github/ISSUE_TEMPLATE/rule_proposal.yml) if the rule is new.

## Changesets

User-visible changes need a changeset. Run `npm run changeset` and commit the generated file in `.changeset/`. Config: `.changeset/config.json`. The owner decides version bumps and publishes.

## Reporting bugs and proposing features

Use the issue forms. Do not paste secrets, tokens or real customer data into an issue. Redact them first.

Do not report security vulnerabilities in issues. See [SECURITY.md](SECURITY.md).
