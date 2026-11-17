'use strict';
/**
 * Live sessions for the agent view, read from Claude Code's own transcripts (read-only).
 *
 * Why transcripts and not only hooks: hooks load only when a session starts in a folder that has this
 * repo's .claude/settings.json. Sessions started in the parent folder (E:\...\open-source-project-blueprints)
 * or in a desktop-app worktree never run them, so their agents never reached .claude/agent-activity.log.
 * Every session, wherever it started, writes a transcript under <claude home>/projects/<cwd slug>/, so the
 * server reads those instead.
 *
 * Scope: only transcript folders for the repo, its parent folder and its git worktrees, and only sessions
 * or subagents whose working directory is the repo, one of its worktrees, a sibling `bfe-*` folder, or the
 * parent folder itself. Files untouched for SESSION_WINDOW are skipped.
 *
 * Privacy: prompts, tool input and tool output are never returned. The page gets ids, titles, agent types,
 * the short task description Claude gave the subagent, tool NAMES and timestamps. A subagent's first prompt is
 * only searched (in memory) for a roster name, so "general-purpose acting as qa-engineer" shows as qa-engineer.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSION_WINDOW = 6 * 60 * 60 * 1000; // ignore transcripts not written to for 6h
const QUIET_MS = 10 * 60 * 1000; // an unfinished turn with no writes for 10 min is "stalled", not working
const MAX_SESSIONS = 40;
const MAX_SUBAGENTS = 40;
const MAX_MAIN_TAIL = 512 * 1024;
const MAX_SUB_BYTES = 4 * 1024 * 1024;

const WIN = process.platform === 'win32';
const norm = (p) => { const r = path.resolve(p); return WIN ? r.toLowerCase() : r; };
const slug = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const ident = (v, max) => String(v || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max);

function projectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** Paths of this repo's linked worktrees, from <root>/.git/worktrees/<name>/gitdir (pure fs, no git process). */
function worktrees(root) {
  const out = [];
  try {
    const base = path.join(root, '.git', 'worktrees');
    for (const n of fs.readdirSync(base)) {
      try {
        const g = fs.readFileSync(path.join(base, n, 'gitdir'), 'utf8').trim();
        if (g) out.push(path.dirname(path.resolve(g)));
      } catch (_) { /* half-removed worktree */ }
    }
  } catch (_) { /* no worktrees */ }
  return out;
}

/** Is this cwd part of the project? (the repo, a worktree, a sibling bfe-* folder, or the parent folder itself) */
function makeScope(root) {
  const parent = path.dirname(root);
  const roots = [root, ...worktrees(root)].map(norm);
  const nParent = norm(parent);
  const inside = (c, r) => c === r || c.startsWith(r + path.sep);
  const ours = (cwd) => {
    if (!cwd) return false;
    const c = norm(cwd);
    if (c === nParent || roots.some((r) => inside(c, r))) return true;
    const rel = path.relative(nParent, c);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && /^bfe-/i.test(rel.split(path.sep)[0]);
  };
  const prefixes = [slug(parent), ...worktrees(root).map(slug)];
  const dirMatch = (name) => prefixes.some((p) => name === p || name.startsWith(`${p}-`));
  return { ours, dirMatch, parent };
}

function readTail(file, size, max) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, max);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let s = buf.toString('utf8');
      if (len < size) s = s.slice(s.indexOf('\n') + 1); // drop the partial first line
      return s;
    } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
}

function entries(s) {
  const out = [];
  for (const line of s.split('\n')) {
    if (!line || line[0] !== '{') continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* partial line being written */ }
  }
  return out;
}

/** Turn state + tool use from transcript entries. Never keeps message text. */
function summarize(list) {
  const r = { cwd: '', branch: '', title: '', firstAt: null, lastAt: null, tools: 0, lastTool: '', ended: false, firstPrompt: '' };
  for (const o of list) {
    if (o.timestamp) { r.firstAt = r.firstAt || o.timestamp; r.lastAt = o.timestamp; }
    if (o.cwd) r.cwd = o.cwd;
    if (o.gitBranch && o.gitBranch !== 'HEAD') r.branch = o.gitBranch;
    if (o.type === 'custom-title' && o.customTitle) r.title = o.customTitle;
    else if (o.type === 'agent-name' && o.agentName && !r.title) r.title = o.agentName;
    const content = o.message && o.message.content;
    if (o.type === 'assistant') {
      let used = false;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'tool_use') { r.tools += 1; r.lastTool = ident(c.name, 80); used = true; }
        }
      }
      r.ended = !used && o.message && o.message.stop_reason === 'end_turn';
      if (used && r.lastTool === 'SubagentHandback') r.ended = true;
    } else if (o.type === 'user') {
      if (!r.firstPrompt) r.firstPrompt = typeof content === 'string' ? content.slice(0, 1500)
        : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ').slice(0, 1500) : '';
      const interrupted = Array.isArray(content) && content.some((c) => c && c.type === 'text' && /^\[Request interrupted/.test(c.text || ''));
      r.ended = interrupted;
    } else if (o.type === 'system' && o.subtype === 'stop_hook_summary') r.ended = true;
  }
  return r;
}

const cache = new Map(); // file → { key, value }
function cached(file, st, fn) {
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.value;
  const value = fn();
  cache.set(file, { key, value });
  return value;
}

const woOf = (...xs) => { for (const x of xs) { const m = /\bWO-?(\d{3})\b/i.exec(x || ''); if (m) return `WO-${m[1]}`; } return ''; };

/** The project role a generic subagent was asked to play ("You are the project's `qa-engineer`"). */
function inferRole(prompt, names) {
  let best = '', at = Infinity;
  const head = String(prompt || '').slice(0, 600);
  for (const n of names) {
    const i = head.search(new RegExp(`(^|[^A-Za-z0-9-])${n.replace(/[.*+?^$()|[\]{}]/g, '')}([^A-Za-z0-9-]|$)`));
    if (i >= 0 && i < at) { best = n; at = i; }
  }
  return best;
}

function subagents(dir, scope, names, now) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^agent-[A-Za-z0-9]+\.jsonl$/.test(f)); } catch (_) { return out; }
  for (const f of files) {
    const file = path.join(dir, f);
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    if (now - st.mtimeMs > SESSION_WINDOW) continue;
    const v = cached(file, st, () => {
      const s = summarize(entries(readTail(file, st.size, MAX_SUB_BYTES)));
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch (_) { /* older format */ }
      const type = ident(meta.agentType, 60) || 'agent';
      const role = names.includes(type) ? type : inferRole(s.firstPrompt, names);
      return {
        id: ident(f.slice(6, -6), 32), agent: role || type, via: role && role !== type ? type : '',
        desc: text(meta.description, 90), cwd: s.cwd, branch: s.branch, startedAt: s.firstAt, lastAt: s.lastAt,
        tools: s.tools, lastTool: s.lastTool, finished: meta.finished === true || s.ended,
      };
    });
    if (v.cwd && !scope.ours(v.cwd)) continue;
    const quiet = now - st.mtimeMs > QUIET_MS;
    out.push({ ...v, status: v.finished ? 'done' : quiet ? 'stalled' : 'working', mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SUBAGENTS);
}

/**
 * → [{ id, sid, title, wo, worktree, branch, status, lastAt, tools, lastTool, agents: [...] }]
 * status: 'working' (turn running or a subagent running) | 'waiting' (turn ended) | 'stalled' (no writes 10 min).
 */
function sessions(root, names) {
  const now = Date.now();
  const scope = makeScope(root);
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir()).filter(scope.dirMatch); } catch (_) { return out; }
  for (const d of dirs) {
    const pdir = path.join(projectsDir(), d);
    let files = [];
    try { files = fs.readdirSync(pdir).filter((f) => /^[0-9a-f-]{36}\.jsonl$/i.test(f)); } catch (_) { continue; }
    for (const f of files) {
      const file = path.join(pdir, f);
      const sdir = file.slice(0, -6);
      let st;
      try { st = fs.statSync(file); } catch (_) { continue; }
      let subs = [];
      try { if (fs.statSync(path.join(sdir, 'subagents')).isDirectory()) subs = subagents(path.join(sdir, 'subagents'), scope, names, now); } catch (_) { /* none */ }
      const newest = Math.max(st.mtimeMs, ...subs.map((a) => a.mtime));
      if (now - newest > SESSION_WINDOW) continue;
      const s = cached(file, st, () => summarize(entries(readTail(file, st.size, MAX_MAIN_TAIL))));
      if (s.cwd && !scope.ours(s.cwd) && !subs.length) continue;
      let title = s.title;
      try { title = JSON.parse(fs.readFileSync(path.join(sdir, 'custom-title.json'), 'utf8')).customTitle || title; } catch (_) { /* untitled */ }
      const cwds = [s.cwd, ...subs.map((a) => a.cwd)].filter(Boolean);
      // The folder directly under the parent: "bug-free-eureka", "bfe-wo006", … ("(parent folder)" for the parent itself).
      const top = (c) => { const rel = path.relative(scope.parent, c); return !rel ? '(parent folder)' : rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(c) : rel.split(path.sep)[0]; };
      const wts = cwds.map(top);
      const wt = wts.find((b) => /^bfe-/i.test(b)) || wts.find((b) => b !== '(parent folder)') || wts[0] || '';
      const branch = s.branch || (subs.find((a) => a.branch) || {}).branch || '';
      const turn = s.ended ? 'waiting' : now - st.mtimeMs > QUIET_MS ? 'stalled' : 'working';
      const status = turn === 'working' || subs.some((a) => a.status === 'working') ? 'working' : turn;
      const sid = ident(f.slice(0, 36), 36);
      out.push({
        id: sid.slice(0, 8), sid: sid.slice(0, 7), title: text(title, 100), wo: woOf(title, branch, wt, ...subs.map((a) => a.desc)),
        worktree: text(wt, 60), branch: text(branch, 80), status, turn, lastAt: new Date(newest).toISOString(),
        tools: s.tools, lastTool: s.lastTool,
        agents: subs.map(({ cwd, mtime, finished, branch: _b, ...a }) => a),
      });
    }
  }
  const rank = { working: 0, waiting: 1, stalled: 2 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || Date.parse(b.lastAt) - Date.parse(a.lastAt)).slice(0, MAX_SESSIONS);
}

module.exports = { sessions, inferRole, makeScope };
