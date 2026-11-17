---
name: work-order
description: Run one Bug-Free Eureka work order (WO-xxx) or rule (BFE-xxx) end to end — scope, branch, delegate, verify, PR, update the status board. Use whenever the owner says "start WO-xxx", "do BFE-xxx", or gives a feature request.
---

# Run a work order

1. **Scope** — find the row in `docs/WORK_ORDERS.md` and its BLUEPRINT section. Write acceptance criteria as a checklist (TaskCreate, one task per deliverable). Anything ambiguous that is the owner's call → ask once, with a recommendation.
2. **Branch** — `git fetch origin main && git switch -c <type>/<WO-or-BFE-id>-<slug> origin/main` (or the session's assigned branch).
3. **Delegate** — per `docs/AI_TEAM.md` routing table. Brief template:
   ```
   Goal: … | Files: … | Rules: CLAUDE.md §… | Done when: … | Don't touch: … | Report: ≤150 words, file:line evidence
   ```
   Parallelise independent briefs in one message.
4. **Verify** — always `qa-engineer` with `verify-change`. Add `security-reviewer` if the diff touches: redaction/logging, proxy/IP, rate limit, scanner file I/O, CLI args, report output, workflows, dependencies.
5. **Fix loop** — findings go back to the author with the exact `file:line`. Max 2 loops, then escalate to the owner with the disagreement stated.
6. **Changeset** — for any change to a publishable package: `npx changeset` (patch/minor per SemVer; pre-1.0 breaking = minor).
7. **Commit** — stage by name; message `<type>(<scope>): <summary> [WO-xxx]`.
8. **PR** — push, open a **draft** PR against `main` using the PR template; body: what, why, verification (paste the QA template), not verified, owner decisions.
9. **Board + README** — in the same PR, set the WO row to `review` with the PR link, and update `README.md` to reflect the WO (rule/package status, badges, compatibility, status note). Edit only the lines this WO affects; no claims beyond what is merged and proven.
10. **Report** — owner report format from `eureka-lead`.
