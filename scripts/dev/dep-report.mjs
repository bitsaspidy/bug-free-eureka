#!/usr/bin/env node
/**
 * Dependency report for Bug-Free Eureka (used by the security-tester's `dependency-watch` skill).
 *
 * For every direct dependency of the root and workspace package.json files it shows: declared range,
 * installed version, latest version, bump type, whether the latest version's engines.node covers our
 * Node targets, peer conflicts with our other dependencies, deprecation and release age; plus an
 * `npm audit` summary. Read-only: installs nothing, changes no file.
 *
 * Usage: node scripts/dev/dep-report.mjs [--json] [--cwd <dir>] [--targets 22.12.0,24.0.0,26.0.0]
 * Exit codes: 0 report produced (even with findings) · 2 usage/config error · 3 unexpected error.
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const NAME_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i; // npm package name; also blocks shell metacharacters
const COOLDOWN_DAYS = 14;
const CONCURRENCY = 4;
const NPM_TIMEOUT_MS = 30_000;

function fail(code, msg) { process.stderr.write(`dep-report: ${msg}\n`); process.exit(code); }

function parseArgs(argv) {
  const o = { json: false, cwd: process.cwd(), targets: ['22.12.0', '24.0.0', '26.0.0'] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--cwd' && argv[i + 1]) o.cwd = path.resolve(argv[(i += 1)]);
    else if (a === '--targets' && argv[i + 1]) o.targets = argv[(i += 1)].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') { process.stdout.write('Usage: node scripts/dev/dep-report.mjs [--json] [--cwd <dir>] [--targets 22.12.0,24.0.0,26.0.0]\n'); process.exit(0); }
    else fail(2, `unknown argument "${a}" (try --help)`);
  }
  return o;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { fail(2, `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`); }
}

/** Root + workspace manifests (supports "dir/*" and exact paths, which is all this repo uses). */
function manifests(root) {
  const rootFile = path.join(root, 'package.json');
  if (!existsSync(rootFile)) fail(2, `no package.json in ${root}`);
  const rootPkg = readJson(rootFile);
  const out = [{ where: '.', pkg: rootPkg }];
  const ws = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages ?? [];
  for (const pattern of ws) {
    const dirs = pattern.endsWith('/*')
      ? (existsSync(path.join(root, pattern.slice(0, -2)))
        ? readdirSync(path.join(root, pattern.slice(0, -2)), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(pattern.slice(0, -2), d.name))
        : [])
      : [pattern];
    for (const d of dirs.sort()) {
      const f = path.join(root, d, 'package.json');
      if (existsSync(f)) out.push({ where: d.split(path.sep).join('/'), pkg: readJson(f) });
    }
  }
  return out;
}

function runNpm(args, cwd) {
  // On Windows npm is a .cmd shim; Node ≥18.20/20.12 refuses to spawn .cmd without a shell (CVE-2024-27980).
  // Package names are validated with NAME_RE before reaching here, so the shell sees no metacharacters.
  const win = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(win ? 'npm.cmd' : 'npm', args, { cwd, timeout: NPM_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, shell: win, windowsHide: true },
      (err, stdout) => resolve({ ok: !err || Boolean(stdout), stdout: String(stdout || ''), err }));
  });
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; results[i] = await fn(items[i]); }
  }));
  return results;
}

/** semver is not a dependency of this repo; use the copy npm/most trees already have, else degrade honestly. */
function loadSemver(root) {
  const nodeDir = path.dirname(process.execPath);
  const npmDirs = [
    process.env.npm_execpath ? path.resolve(path.dirname(process.env.npm_execpath), '..') : null, // run via npm script
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm'), // Linux/macOS installs
    path.join(nodeDir, 'node_modules', 'npm'), // Windows installs
  ].filter(Boolean);
  const bases = [path.join(root, 'package.json'), import.meta.url, ...npmDirs.map((d) => path.join(d, 'package.json'))];
  for (const base of bases) {
    try { return createRequire(base)('semver'); } catch { /* try next */ }
  }
  return null;
}

function installedVersion(root, where, name) {
  for (const dir of [path.join(root, where, 'node_modules', name), path.join(root, 'node_modules', name)]) {
    try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { /* not installed here */ }
  }
  return null;
}

function bumpType(semver, from, to) {
  if (!semver || !from || !to || !semver.valid(from) || !semver.valid(to)) return '?';
  if (semver.eq(from, to)) return 'current';
  return semver.diff(from, to) ?? '?';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = opts.cwd;
  const semver = loadSemver(root);
  const all = manifests(root);

  /** name → { ranges: [{where, kind, range}] } */
  const deps = new Map();
  for (const { where, pkg } of all) {
    for (const kind of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(pkg[kind] ?? {})) {
        if (!NAME_RE.test(name)) { process.stderr.write(`dep-report: skipping invalid package name "${name}"\n`); continue; }
        if (all.some((m) => m.pkg.name === name)) continue; // our own workspace package
        if (!deps.has(name)) deps.set(name, { ranges: [] });
        deps.get(name).ranges.push({ where, kind, range: String(range) });
      }
    }
  }
  const names = [...deps.keys()].sort();

  const meta = await pool(names, CONCURRENCY, async (name) => {
    const r = await runNpm(['view', `${name}@latest`, 'version', 'engines', 'peerDependencies', 'deprecated', 'time', '--json'], root);
    if (!r.ok) return { name, error: 'npm view failed (offline, private or unknown package?)' };
    try {
      const j = JSON.parse(r.stdout);
      if (j && typeof j === 'object' && j.error) {
        return { name, error: `npm view: ${String(j.error.code ?? j.error.summary ?? 'error').slice(0, 60)} (unpublished, private or offline)` };
      }
      return { name, ...j };
    } catch { return { name, error: 'unparseable npm view output' }; }
  });

  const now = Date.now();
  const rows = meta.map((m) => {
    const info = deps.get(m.name);
    const first = info.ranges[0];
    const current = installedVersion(root, first.where, m.name)
      ?? (semver ? semver.minVersion(first.range)?.version ?? null : null);
    if (m.error) return { name: m.name, declared: info.ranges, current, error: m.error };

    const latest = m.version;
    const released = m.time?.[latest] ? new Date(m.time[latest]).getTime() : NaN;
    const ageDays = Number.isFinite(released) ? Math.floor((now - released) / 86_400_000) : null;
    const enginesNode = m.engines?.node ?? null;
    const nodeOk = Object.fromEntries(opts.targets.map((t) => [t, enginesNode == null ? 'unspecified'
      : semver ? semver.satisfies(t, enginesNode, { includePrerelease: false }) : 'manual']));

    // Peer conflicts: latest's peer ranges vs the versions we declare for those peers.
    const peerIssues = [];
    const peerManual = [];
    for (const [peer, prange] of Object.entries(m.peerDependencies ?? {})) {
      const ours = deps.get(peer);
      if (!ours) continue;
      const ourVer = installedVersion(root, ours.ranges[0].where, peer) ?? (semver ? semver.minVersion(ours.ranges[0].range)?.version : null);
      if (!semver || !ourVer) { peerManual.push(`${peer} ${prange}`); continue; }
      if (!semver.satisfies(ourVer, prange, { includePrerelease: true })) peerIssues.push(`${peer}@${ourVer} ∉ ${prange}`);
    }

    const flags = [];
    if (m.deprecated) flags.push('DEPRECATED');
    if (ageDays != null && ageDays < COOLDOWN_DAYS) flags.push(`cooldown (${COOLDOWN_DAYS - ageDays}d left)`);
    if (Object.values(nodeOk).includes(false)) {
      const isRuntime = info.ranges.some((r) => r.kind !== 'devDependencies');
      flags.push(`${isRuntime ? 'RUNTIME ' : ''}engines exclude ${opts.targets.filter((t) => nodeOk[t] === false).join('/')} (needs ${enginesNode})`);
    }
    if (peerIssues.length) flags.push('peer conflict');
    if (peerManual.length) flags.push('peer check manual');
    const declaredInRange = semver && current ? info.ranges.every((r) => semver.satisfies(latest, r.range)) : null;

    return { name: m.name, declared: info.ranges, current, latest, bump: bumpType(semver, current, latest), ageDays, enginesNode, nodeOk, peerIssues, peerManual, deprecated: m.deprecated ?? null, latestWithinDeclaredRange: declaredInRange, flags };
  });

  // npm audit summary (needs a lockfile; never fatal).
  let audit = { available: false };
  if (existsSync(path.join(root, 'package-lock.json'))) {
    const a = await runNpm(['audit', '--json'], root);
    try { const j = JSON.parse(a.stdout); audit = { available: true, vulnerabilities: j.metadata?.vulnerabilities ?? null }; }
    catch { audit = { available: false, note: 'npm audit output unparseable (offline?)' }; }
  } else audit.note = 'no package-lock.json — run after WO-001';

  const report = { generatedAt: new Date(now).toISOString(), nodeTargets: opts.targets, semverAvailable: Boolean(semver), audit, dependencies: rows };
  if (opts.json) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }

  const yes = (v) => (v === true ? '✓' : v === false ? '✗' : v === 'unspecified' ? '·' : '?');
  const lines = [
    `Dependency report — ${report.generatedAt.slice(0, 10)} · Node targets ${opts.targets.join(', ')}${semver ? '' : ' · semver unavailable: engine/peer checks marked "?"'}`,
    '',
    `| Package | Current | Latest | Bump | Node ${opts.targets.map((t) => t.split('.')[0]).join('/')} | Age (d) | Peers | Flags |`,
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => (r.error
      ? `| ${r.name} | ${r.current ?? '—'} | — | — | — | — | — | ${r.error} |`
      : `| ${r.name} | ${r.current ?? '—'} | ${r.latest} | ${r.bump} | ${opts.targets.map((t) => yes(r.nodeOk[t])).join('')} | ${r.ageDays ?? '?'} | ${r.peerIssues.length ? r.peerIssues.join('; ') : '✓'} | ${r.flags.join(', ') || '—'} |`)),
    '',
    `npm audit: ${audit.available ? JSON.stringify(audit.vulnerabilities) : audit.note}`,
    'Legend: ✓ ok · ✗ excluded · · engines unspecified · ? unknown. Lock-step groups and changelogs: see dependency-watch skill.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((e) => fail(3, `unexpected error: ${e instanceof Error ? e.message : String(e)}`));
