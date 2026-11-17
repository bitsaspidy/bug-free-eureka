## What

<!-- One or two sentences. What does this change do? -->

## Why

<!-- The problem or work order it solves. -->

**WO / BFE id:** <!-- e.g. WO-001, BFE-001 -->

## Verification

Run locally before you mark the PR ready. CI runs the full matrix.

- [ ] `npm ci`
- [ ] `npm run build`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm test`
- [ ] `npm run test:coverage` (required when rule logic changes)

**Not verified:** <!-- List anything you did not run or could not check, and why. Write "none" only if true. -->

## Rules (if this adds or changes a rule)

- [ ] `pass`, `fail` and `not_assessed` fixtures added
- [ ] `docs/rules/BFE-XXX.md` added or updated

## Docs

- [ ] `README.md` updated to reflect this work order (or not needed: explain below)
- [ ] `docs/WORK_ORDERS.md` row set to `review` with this PR's link

## Release

- [ ] Changeset added (or not needed: explain below)

## Security

- [ ] This change is security-sensitive (redaction, parsing, file access, network, auth, output format, dependencies)

If checked, the owner must review it. Do not discuss vulnerabilities in this PR. Report them privately per [SECURITY.md](../SECURITY.md).

## Owner decisions

<!-- Choices that only the owner can make: scope, breaking changes, new dependencies, public API changes. Otherwise write "none". -->
