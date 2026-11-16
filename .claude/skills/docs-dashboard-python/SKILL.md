---
name: docs-dashboard-python
description: Standards for Bug-Free Eureka's secondary stacks — VitePress docs site (apps/docs + docs/), GitHub Pages deploy, the future local-first React + Vite dashboard that renders untrusted reports safely, and optional Python report-validation scripts with pytest. Use when working in apps/, docs site config, or scripts/python.
---

# Docs site, dashboard, Python

## VitePress (apps/docs)
* npm latest on 2026-11-16: vitepress 1.6. `apps/docs/.vitepress/config.ts` with `srcDir: "../../docs"` so the Markdown lives in `docs/` (single source). `base: "/bug-free-eureka/"` for GitHub Pages.
* Sidebar: Getting started · Configuration · Rules (one page per BFE-xxx, generated index) · Express adapter · CLI & CI (SARIF upload) · Deployment (reverse proxy, Docker, PM2, serverless) · Compatibility · Threat model · Security policy.
* `cleanUrls: true`, `lastUpdated: true`, edit links to GitHub, local search provider. No analytics or third-party scripts by default.
* Deploy with `docs.yml`: build on PR (no deploy), deploy on main with `actions/upload-pages-artifact` + `actions/deploy-pages`, permissions `pages: write, id-token: write` only in the deploy job. Pin by SHA (see `ci-hardening`).
* Docs examples must compile. Put code samples in `examples/` and include them by file region (`<<< @/../examples/basic-express/app.ts#setup`) so they're tested, not hand-copied.

## React + Vite dashboard (apps/dashboard — later, v1.1+)
* Local-first: the user opens a saved report via `<input type="file">` or drag-and-drop. **No upload, no backend, no telemetry.**
* Validate the file with the report Zod schema from `@bug-free-eureka/core` before rendering, and show schema errors readably.
* Reports are untrusted input: render strings as text only. No `dangerouslySetInnerHTML`, no Markdown-to-HTML without a sanitizer, links only `https:` from `references` (validate the scheme), `rel="noopener noreferrer"`.
* A strict CSP meta tag (`default-src 'self'; script-src 'self'; object-src 'none'`). Accessibility at WCAG 2.1 AA (use the `design:accessibility-review` skill). Charts follow the `dataviz` skill.
* Tests: Vitest + Testing Library. A malicious report fixture (script tags, `javascript:` URLs, huge arrays) must render inert and stay responsive.
* A new role is needed before this starts: hire `frontend-engineer` (see docs/AI_TEAM.md).

## Python utilities (scripts/python — optional)
* Python ≥3.11, standard library first. `requirements-dev.txt` pins `pytest` and `jsonschema` exactly. Never required for npm users or `npm test`.
* `validate_findings.py <report.json>`: validates against the JSON Schema exported from core (`z.toJSONSchema`) and checks invariants independently of the TS code: summary counts equal the counted statuses, no `pass` without evidence, rule IDs match `^BFE-\d{3}$`, and no canary or secret patterns. Exit 0 ok, 1 invalid, 2 usage.
* Run isolated: `python -I scripts/python/validate_findings.py report.json`. Treat report files as untrusted data (no `eval`, no pickle).
* Tests: `python -I -m pytest scripts/python -q`. An optional CI job on ubuntu only.
