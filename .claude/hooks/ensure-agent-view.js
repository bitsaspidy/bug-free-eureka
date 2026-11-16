#!/usr/bin/env node
'use strict';
/**
 * SessionStart / UserPromptSubmit hook — make sure the Bug-Free Eureka agent view is running on
 * http://localhost:4778 (override with AGENT_VIEW_PORT).
 *
 * The view is this repo's own .claude/agent-view/server.js and shows ONLY this project. Jyotish Stack keeps
 * its separate view on :4777; this hook never touches ~/.claude/agent-view or its roster.json, so the two
 * projects can't overwrite each other.
 *
 * If the port answers as another project, the hook warns once instead of starting a second server.
 * Skipped in CI and cloud sessions (no one can open localhost there). Never blocks: always exits 0.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PROJECT = 'bug-free-eureka';
const PORT = Number(process.env.AGENT_VIEW_PORT || 4778);
const ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, '.claude', 'agent-view', 'server.js');

process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});

/** → 'ours' | 'other' | 'down' */
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/state.json', timeout: 700, headers: { Host: `127.0.0.1:${PORT}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 1_000_000) body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).project === PROJECT ? 'ours' : 'other'); } catch (_) { resolve('other'); } });
    });
    req.on('error', () => resolve('down'));
    req.on('timeout', () => { req.destroy(); resolve('down'); });
  });
}

(async () => {
  try {
    if (process.env.CI || process.env.CLAUDE_CODE_REMOTE || process.env.AGENT_VIEW === 'off') return process.exit(0);
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || !fs.existsSync(SERVER)) return process.exit(0);
    const s = await probe();
    if (s === 'ours') return process.exit(0);
    if (s === 'other') {
      process.stdout.write(JSON.stringify({ systemMessage: `agent view: port ${PORT} is used by something else — set AGENT_VIEW_PORT to a free port` }));
      return process.exit(0);
    }
    const child = spawn(process.execPath, [SERVER], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, AGENT_VIEW_PORT: String(PORT) } });
    child.on('error', () => {});
    child.unref();
    for (let i = 0; i < 10 && (await probe()) !== 'ours'; i += 1) await new Promise((r) => setTimeout(r, 150));
    process.stdout.write(JSON.stringify({ systemMessage: `Bug-Free Eureka agent view: http://localhost:${PORT}` }));
  } catch (_) { /* never block the session */ }
  process.exit(0);
})();
